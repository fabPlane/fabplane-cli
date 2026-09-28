import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_API_ORIGIN, dashboardUrlFor, normalizeOrigin } from "../src/index.js";

describe("dashboardUrlFor", () => {
  const cases: Array<[string, string]> = [
    ["https://api.fabplane.com", "https://app.fabplane.com/dashboard"],
    ["https://api.fabplane.com/", "https://app.fabplane.com/dashboard"],
    ["api.fabplane.com", "https://app.fabplane.com/dashboard"],
    ["http://staging.example.test:4000", "http://staging.example.test:5173/dashboard"],
    ["https://box.internal:4000", "https://box.internal:5173/dashboard"],
    ["http://localhost:4000", "http://localhost:5173/dashboard"],
    ["http://localhost:8787", "http://localhost:5173/dashboard"],
    ["http://127.0.0.1:9999", "http://127.0.0.1:5173/dashboard"],
    ["https://api.example.org", "https://app.example.org/dashboard"],
    ["https://api.example.org:8443", "https://app.example.org:8443/dashboard"],
    ["https://fabplane.example.org", "https://fabplane.example.org/dashboard"],
  ];
  for (const [origin, expected] of cases) {
    it(`${origin} → ${expected}`, () => assert.equal(dashboardUrlFor(origin), expected));
  }
  it("defaults to production", () => {
    assert.equal(DEFAULT_API_ORIGIN, "https://api.fabplane.com");
    assert.equal(dashboardUrlFor(), "https://app.fabplane.com/dashboard");
  });
  it("normalizeOrigin trims slashes and adds https", () => {
    assert.equal(normalizeOrigin("api.example.org///"), "https://api.example.org");
    assert.equal(normalizeOrigin("http://localhost:4000/"), "http://localhost:4000");
  });
});
