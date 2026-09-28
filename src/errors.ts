/**
 * A non-2xx answer from the fabplane API. `code` is the body's `error` field
 * (`not_found`, `server_ai_unavailable`, …) or `http_<status>` when the body has none.
 */
export class FabplaneApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;

  constructor(opts: { status: number; code: string; message: string; body: unknown; method: string; path: string }) {
    super(opts.message);
    this.name = "FabplaneApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
    this.method = opts.method;
    this.path = opts.path;
  }

  /** Builds the error from a failed response, reading its body once. */
  static async fromResponse(res: Response, method: string, path: string): Promise<FabplaneApiError> {
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    let code = `http_${res.status}`;
    let message = `${method} ${path} failed with HTTP ${res.status}`;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b["error"] === "string") code = b["error"];
      const detail =
        typeof b["message"] === "string"
          ? b["message"]
          : typeof b["error_description"] === "string"
            ? b["error_description"]
            : undefined;
      message = detail ? detail : `${message}: ${code}`;
    } else if (typeof body === "string" && body.trim()) {
      message = `${message}: ${body.trim().slice(0, 300)}`;
    }
    return new FabplaneApiError({ status: res.status, code, message, body, method, path });
  }
}

export function isFabplaneApiError(err: unknown): err is FabplaneApiError {
  return err instanceof FabplaneApiError;
}
