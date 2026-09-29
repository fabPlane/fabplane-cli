import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ImageFetchError, MAX_IMAGE_BYTES, fetchImage, imageFromBase64, sniffImageType, validateImage } from "../src/index.js";
import { JPEG_BYTES, PNG_BYTES, startFakeApi, type FakeApi } from "./fake-api.js";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("sniffImageType / validateImage", () => {
  it("recognises png, jpeg, gif, webp, heic and heif", () => {
    assert.equal(sniffImageType(new Uint8Array(PNG_BYTES)), "image/png");
    assert.equal(sniffImageType(new Uint8Array(JPEG_BYTES)), "image/jpeg");
    assert.equal(sniffImageType(new Uint8Array(ascii("GIF89a...."))), "image/gif");
    assert.equal(sniffImageType(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")])), "image/webp");
    assert.equal(sniffImageType(new Uint8Array([0, 0, 0, 24, ...ascii("ftypheic")])), "image/heic");
    assert.equal(sniffImageType(new Uint8Array([0, 0, 0, 24, ...ascii("ftypmif1")])), "image/heif");
    assert.equal(sniffImageType(new Uint8Array(ascii("<html>"))), undefined);
  });

  it("prefers sniffed bytes, accepts a known declared type, rejects the rest", () => {
    assert.equal(validateImage(new Uint8Array(PNG_BYTES), "application/octet-stream"), "image/png");
    assert.equal(validateImage(new Uint8Array([1, 2, 3]), "image/jpg; charset=binary"), "image/jpeg");
    assert.throws(() => validateImage(new Uint8Array(ascii("<html>")), "text/html"), ImageFetchError);
    assert.throws(() => validateImage(new Uint8Array([1]), "image/svg+xml"), /Not an accepted image/);
    assert.throws(() => validateImage(new Uint8Array(0), "image/png"), /empty/);
    assert.throws(() => validateImage(new Uint8Array(PNG_BYTES), "image/png", 10), /limit is 10/);
  });

  it("imageFromBase64 decodes plain base64 and data: URLs", () => {
    const b64 = PNG_BYTES.toString("base64");
    assert.equal(imageFromBase64(b64).contentType, "image/png");
    const fromData = imageFromBase64(`data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`);
    assert.equal(fromData.contentType, "image/jpeg");
    assert.equal(fromData.filename, "image.jpg");
    assert.throws(() => imageFromBase64(Buffer.from("hello").toString("base64")), /Not an accepted image/);
  });
});

describe("fetchImage", () => {
  let api: FakeApi;
  before(async () => {
    api = await startFakeApi();
  });
  after(() => api.close());

  it("downloads an image and names it from the URL", async () => {
    const r = await fetchImage(`${api.origin}/img/part.png`);
    assert.equal(r.image.contentType, "image/png");
    assert.equal(r.image.filename, "part.png");
    assert.equal(r.bytes, PNG_BYTES.length);
  });

  it("follows redirects and reports the final URL", async () => {
    const r = await fetchImage(`${api.origin}/img/redirect`);
    assert.equal(r.finalUrl, `${api.origin}/img/part.png`);
    assert.equal(r.image.contentType, "image/png");
  });

  it("sniffs magic bytes when the server says octet-stream", async () => {
    const r = await fetchImage(`${api.origin}/img/octet`);
    assert.equal(r.image.contentType, "image/jpeg");
    assert.equal(r.image.filename, "octet.jpg");
  });

  it("rejects HTML pages, 404s, oversize images, timeouts and non-http URLs", async () => {
    await assert.rejects(fetchImage(`${api.origin}/img/page.html`), /Not an accepted image \(text\/html/);
    await assert.rejects(fetchImage(`${api.origin}/img/missing`), /HTTP 404/);
    await assert.rejects(fetchImage(`${api.origin}/img/big-declared`), new RegExp(`limit is ${MAX_IMAGE_BYTES}`));
    await assert.rejects(fetchImage(`${api.origin}/img/big-streamed`), /larger than 10485760 bytes/);
    await assert.rejects(fetchImage(`${api.origin}/img/slow`, { timeoutMs: 200 }), /Timed out after 200 ms/);
    await assert.rejects(fetchImage("file:///etc/passwd"), /Only http\(s\)/);
    await assert.rejects(fetchImage("not a url"), /Invalid image URL/);
  });
});
