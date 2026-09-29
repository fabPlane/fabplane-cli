import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { FabplaneClient, VERSION, fabplaneTools, operations } from "../src/index.js";

// Works from both test/ (bun) and build-test/test/ (node): walk up to the package root.
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "fabplane-cli") return dir;
    } catch {
      /* keep walking */
    }
    dir = dirname(dir);
  }
  throw new Error("package root not found");
}
const root = findRoot();
const spec = JSON.parse(readFileSync(join(root, "spec", "openapi.json"), "utf8")) as { openapi: string; paths: Record<string, Record<string, { operationId?: string }>> };
const specOps = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).flatMap(([method, op]) => (op.operationId ? [{ operationId: op.operationId, method: method.toUpperCase(), path }] : [])),
);

describe("spec coverage", () => {
  it("spec/openapi.json is OpenAPI 3.1 with operations", () => {
    assert.match(spec.openapi, /^3\.1/);
    assert.ok(specOps.length >= 46);
  });

  it("every operationId in spec/openapi.json has a FabplaneClient method", () => {
    const missing = specOps.filter((o) => typeof (FabplaneClient.prototype as unknown as Record<string, unknown>)[o.operationId] !== "function");
    assert.deepEqual(missing, [], `missing client methods: ${missing.map((o) => o.operationId).join(", ")}`);
  });

  it("operationIds are unique", () => {
    const ids = specOps.map((o) => o.operationId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("src/generated/operations.ts matches the spec (run `npm run sync-spec -- --offline`)", () => {
    const key = (o: { operationId: string; method: string; path: string }) => `${o.operationId} ${o.method} ${o.path}`;
    assert.deepEqual(operations.map(key).sort(), specOps.map(key).sort());
  });

  it("the contract's MCP tool names are all present", () => {
    assert.deepEqual(
      fabplaneTools.map((t) => t.name),
      ["org_list", "destination_list", "cart_list", "cart_get", "cart_create", "cart_add_items", "cart_update_item", "cart_remove_item", "inventory_search", "inventory_add", "inventory_adjust", "inventory_photo_queue", "inventory_photo_claim", "inventory_photo_attach", "inventory_photo_release"],
    );
    for (const t of fabplaneTools) assert.match(t.name, /^[a-z][a-z0-9_]*$/);
  });

  it("VERSION matches package.json", () => {
    assert.equal(VERSION, (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version);
  });

  it("spec/fabdesk-tools.json is a tool manifest snapshot", () => {
    const snap = JSON.parse(readFileSync(join(root, "spec", "fabdesk-tools.json"), "utf8")) as { tools: Array<{ name: string; inputSchema: unknown }> };
    assert.ok(snap.tools.length > 0);
    for (const t of snap.tools) {
      assert.match(t.name, /^[a-z][a-z0-9_]*$/);
      assert.equal(typeof t.inputSchema, "object");
    }
  });
});

describe("workflows", () => {
  const wf = (name: string) => readFileSync(join(root, ".github", "workflows", name), "utf8");

  it("publish.yml checks NPM_TOKEN first and gates npm publish on it", () => {
    const text = wf("publish.yml");
    const steps = text.slice(text.indexOf("steps:"));
    assert.ok(steps.indexOf("Check NPM_TOKEN") < steps.indexOf("actions/checkout"), "the token check is the first step");
    assert.match(text, /::error title=NPM_TOKEN missing::Please add the NPM_TOKEN repository secret/);
    assert.match(text, /exit 1/);
    const publish = text.slice(text.indexOf("- name: npm publish"));
    assert.match(publish, /if: steps\.token\.outputs\.present == 'true'/);
    assert.match(publish, /npm publish --provenance --access public/);
    assert.match(text, /id-token: write/);
  });

  it("sync-api.yml runs weekly and on demand and tolerates a missing endpoint", () => {
    const text = wf("sync-api.yml");
    assert.match(text, /cron: "0 3 \* \* 1"/);
    assert.match(text, /workflow_dispatch/);
    assert.match(text, /peter-evans\/create-pull-request@v7/);
    assert.match(text, /if: steps\.sync\.outputs\.changed == 'true'/);
  });
});
