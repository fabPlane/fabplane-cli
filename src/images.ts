/**
 * Client-side image fetching and validation for photo backfill: the API only accepts uploads,
 * so a worker downloads a product photo itself, checks it, and sends the bytes.
 */
import type { FetchLike } from "./client.js";
import type { ImageUpload } from "./types.js";

/** The API's per-image limit. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"] as const;
export const DEFAULT_IMAGE_TIMEOUT_MS = 20_000;

export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFetchError";
  }
}

/** Identifies an image from its first bytes; `undefined` when it is none of the accepted formats. */
export function sniffImageType(bytes: Uint8Array): (typeof IMAGE_CONTENT_TYPES)[number] | undefined {
  const b = (i: number) => bytes[i] ?? -1;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (b(0) === 0x89 && ascii(1, 4) === "PNG" && b(4) === 0x0d && b(5) === 0x0a) return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "heim", "heis", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return undefined;
}

function normalizeType(header: string | null): string | undefined {
  const t = header?.split(";")[0]?.trim().toLowerCase();
  if (!t) return undefined;
  return t === "image/jpg" || t === "image/pjpeg" ? "image/jpeg" : t;
}

/**
 * Checks bytes are an accepted image of at most `maxBytes`. The sniffed type wins; a declared
 * `image/*` type is accepted when sniffing is inconclusive and the type is one the API takes.
 */
export function validateImage(bytes: Uint8Array, declaredType?: string | null, maxBytes = MAX_IMAGE_BYTES): (typeof IMAGE_CONTENT_TYPES)[number] {
  if (bytes.byteLength === 0) throw new ImageFetchError("The image is empty");
  if (bytes.byteLength > maxBytes) throw new ImageFetchError(`The image is ${bytes.byteLength} bytes; the limit is ${maxBytes} (10 MiB)`);
  const sniffed = sniffImageType(bytes);
  if (sniffed) return sniffed;
  const declared = normalizeType(declaredType ?? null);
  if (declared && (IMAGE_CONTENT_TYPES as readonly string[]).includes(declared)) return declared as (typeof IMAGE_CONTENT_TYPES)[number];
  throw new ImageFetchError(
    `Not an accepted image (${declared ?? "no content type"}, unrecognised bytes). Accepted: png, jpeg, webp, gif, heic, heif.`,
  );
}

function filenameFrom(url: URL, contentType: string): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const ext = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1] ?? "img";
  const base = last.replace(/[^\w.-]+/g, "_").slice(0, 100);
  if (!base) return `image.${ext}`;
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
}

/**
 * Downloads an image URL (http/https only), following redirects, with a timeout and a hard size
 * cap enforced while streaming. Returns the upload plus the final URL after redirects.
 */
export async function fetchImage(
  imageUrl: string,
  opts: { fetch?: FetchLike; maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ image: ImageUpload & { filename: string }; finalUrl: string; bytes: number }> {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new ImageFetchError(`Invalid image URL: ${imageUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ImageFetchError(`Only http(s) image URLs are supported (got ${url.protocol})`);
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  const fetchImpl = opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        redirect: "follow",
        signal: controller.signal,
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
      });
    } catch (err) {
      if (controller.signal.aborted) throw new ImageFetchError(`Timed out after ${timeoutMs} ms downloading ${imageUrl}`);
      throw new ImageFetchError(`Could not download ${imageUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new ImageFetchError(`Downloading ${imageUrl} failed with HTTP ${res.status}`);
    }
    const length = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new ImageFetchError(`The image is ${length} bytes; the limit is ${maxBytes} (10 MiB)`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new ImageFetchError(`The image is larger than ${maxBytes} bytes (10 MiB)`);
          }
          chunks.push(value);
        }
      } catch (err) {
        if (err instanceof ImageFetchError) throw err;
        if (controller.signal.aborted) throw new ImageFetchError(`Timed out after ${timeoutMs} ms downloading ${imageUrl}`);
        throw new ImageFetchError(`Could not download ${imageUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    const contentType = validateImage(bytes, res.headers.get("content-type"), maxBytes);
    const finalUrl = res.url || url.toString();
    return { image: { data: bytes, contentType, filename: filenameFrom(new URL(finalUrl), contentType) }, finalUrl, bytes: total };
  } finally {
    clearTimeout(timer);
  }
}

/** Decodes base64 (optionally a `data:` URL) and validates it as an image. */
export function imageFromBase64(data: string, contentType?: string, maxBytes = MAX_IMAGE_BYTES): ImageUpload & { filename: string } {
  let payload = data.trim();
  let declared = contentType;
  const m = /^data:([^;,]+)?(;base64)?,/i.exec(payload);
  if (m) {
    declared ??= m[1];
    payload = payload.slice(m[0].length);
  }
  if (payload.length > Math.ceil((maxBytes * 4) / 3) + 8) throw new ImageFetchError(`The image is larger than ${maxBytes} bytes (10 MiB)`);
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  const type = validateImage(bytes, declared, maxBytes);
  return { data: bytes, contentType: type, filename: `image.${type === "image/jpeg" ? "jpg" : type.split("/")[1]}` };
}
