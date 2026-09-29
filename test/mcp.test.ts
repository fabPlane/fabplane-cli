import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FabdeskClient, FabplaneClient, createFabplaneMcpServer, fabplaneTools } from "../src/index.js";
import { JPEG_BYTES, startFakeApi, USER_TOKEN, type FakeApi } from "./fake-api.js";
import { DAEMON_TOKEN, startFakeDaemon } from "./fake-daemon.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connect(server: ReturnType<typeof createFabplaneMcpServer>): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

describe("fabplane MCP server", () => {
  let api: FakeApi;
  let mcp: Client;
  let resolverCalls = 0;
  before(async () => {
    api = await startFakeApi();
    const client = new FabplaneClient({ origin: api.origin, token: USER_TOKEN });
    const personal = (await client.listOrgs()).orgs.find((o) => o.personal)!.id;
    mcp = await connect(
      createFabplaneMcpServer({
        client,
        orgId: async () => {
          resolverCalls++;
          return personal;
        },
      }),
    );
  });
  after(async () => {
    await mcp.close();
    await api.close();
  });

  it("lists every contract tool with schemas and annotations", async () => {
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), fabplaneTools.map((t) => t.name).sort());
    const add = tools.find((t) => t.name === "cart_add_items")!;
    assert.equal(add.inputSchema.type, "object");
    assert.ok(add.inputSchema.properties?.["items"]);
    assert.deepEqual(add.inputSchema.required, ["cartId", "items"]);
    assert.equal(tools.find((t) => t.name === "cart_remove_item")!.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "org_list")!.annotations?.readOnlyHint, true);
    assert.equal(tools.some((t) => t.name.startsWith("desktop_")), false);
  });

  it("runs a cart workflow through the tools with the default org", async () => {
    const created = (await mcp.callTool({ name: "cart_create", arguments: { name: "Rev A", repos: ["https://github.com/a/b"] } })) as TextResult;
    assert.equal(created.isError, undefined);
    const cartId = JSON.parse(created.content[1]!.text).cart.id as string;
    const added = (await mcp.callTool({ name: "cart_add_items", arguments: { cartId, items: [{ mpn: "NE555", quantity: 2, refs: ["U1"] }, { mpn: "10k", quantity: 4, destinationId: "builtin:lcsc" }] } })) as TextResult;
    assert.match(added.content[0]!.text, /Added 2 item/);
    const got = (await mcp.callTool({ name: "cart_get", arguments: { cartId } })) as TextResult;
    assert.match(got.content[0]!.text, /2× NE555 \[U1\] → builtin:jlcpcb/);
    const itemId = JSON.parse(got.content[1]!.text).cart.items[0].id as string;
    const upd = (await mcp.callTool({ name: "cart_update_item", arguments: { cartId, itemId, status: "ordered" } })) as TextResult;
    assert.equal(JSON.parse(upd.content[1]!.text).item.status, "ordered");
    const lastPatch = api.requests.filter((r) => r.method === "PATCH").at(-1)!;
    assert.deepEqual(lastPatch.body, { status: "ordered" }, "only the given fields are sent");
    const listed = (await mcp.callTool({ name: "cart_list", arguments: { repo: "https://github.com/a/b" } })) as TextResult;
    assert.match(listed.content[0]!.text, /Rev A/);
    await mcp.callTool({ name: "cart_remove_item", arguments: { cartId, itemId } });
    const dests = (await mcp.callTool({ name: "destination_list", arguments: {} })) as TextResult;
    assert.match(dests.content[0]!.text, /builtin:digikey/);
    assert.equal(resolverCalls, 1, "the default org is resolved once and cached");
  });

  it("runs the inventory tools", async () => {
    const added = (await mcp.callTool({ name: "inventory_add", arguments: { name: "NE555 timer", mpn: "NE555P", quantity: 10, attributes: { package: "DIP-8", pins: 8 } } })) as TextResult;
    const itemId = JSON.parse(added.content[1]!.text).item.id as string;
    const found = (await mcp.callTool({ name: "inventory_search", arguments: { q: "ne555" } })) as TextResult;
    assert.match(found.content[0]!.text, /NE555 timer \(NE555P\) qty=10/);
    const adj = (await mcp.callTool({ name: "inventory_adjust", arguments: { itemId, delta: -3, reason: "built" } })) as TextResult;
    assert.match(adj.content[0]!.text, /quantity now 7/);
    const tooMuch = (await mcp.callTool({ name: "inventory_adjust", arguments: { itemId, delta: -100 } })) as TextResult;
    assert.equal(tooMuch.isError, true);
    assert.match(tooMuch.content[0]!.text, /409 conflict/);
  });

  it("org_list and an explicit orgId", async () => {
    const res = (await mcp.callTool({ name: "org_list", arguments: {} })) as TextResult;
    assert.match(res.content[0]!.text, /\[personal\]/);
    const bad = (await mcp.callTool({ name: "cart_list", arguments: { orgId: "00000000-0000-4000-8000-000000000000" } })) as TextResult;
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /404 not_found/);
  });

  it("handlers are callable directly (fabdesk embeds them)", async () => {
    const tool = fabplaneTools.find((t) => t.name === "cart_list")!;
    const res = await tool.handler(new FabplaneClient({ origin: api.origin, token: USER_TOKEN }), {}, {});
    assert.equal(res.isError, true);
    assert.match(res.text ?? "", /No org selected/);
  });
});

describe("fabplane MCP server --desktop", () => {
  it("adds desktop_* tools backed by FabdeskClient", async () => {
    const daemon = await startFakeDaemon();
    const home = await mkdtemp(join(tmpdir(), "fabdesk-mcp-"));
    await writeFile(join(home, "daemon.json"), JSON.stringify({ version: "9.9.9", pid: process.pid, port: daemon.port, host: "127.0.0.1", token: DAEMON_TOKEN, startedAt: "now" }));
    const mcp = await connect(createFabplaneMcpServer({ client: new FabplaneClient({ origin: "http://127.0.0.1:9" }), desktop: new FabdeskClient({ env: { FABDESK_HOME: home } }) }));
    try {
      const { tools } = await mcp.listTools();
      for (const n of ["desktop_status", "desktop_projects", "desktop_call_tool"]) assert.ok(tools.some((t) => t.name === n), n);
      const status = (await mcp.callTool({ name: "desktop_status", arguments: {} })) as TextResult;
      assert.match(status.content[0]!.text, /fabdesk 9\.9\.9 running \(auth fabplane\/signed_in as maya\), 1 live run/);
      const projects = (await mcp.callTool({ name: "desktop_projects", arguments: {} })) as TextResult;
      assert.match(projects.content[0]!.text, /p1: Blinky/);
      const listed = (await mcp.callTool({ name: "desktop_call_tool", arguments: {} })) as TextResult;
      assert.match(listed.content[0]!.text, /board_stats/);
      const called = (await mcp.callTool({ name: "desktop_call_tool", arguments: { name: "board_stats", projectId: "p1" } })) as TextResult;
      assert.equal(called.content[0]!.text, "2 layers");
      const failed = (await mcp.callTool({ name: "desktop_call_tool", arguments: { name: "verify_drc" } })) as TextResult;
      assert.equal(failed.isError, true);
    } finally {
      await mcp.close();
      await daemon.close();
    }
  });
});

describe("photo-queue MCP tools", () => {
  it("queue, claim, attach (url and base64), release", async () => {
    const api = await startFakeApi();
    const client = new FabplaneClient({ origin: api.origin, token: USER_TOKEN });
    const orgId = (await client.listOrgs()).orgs.find((o) => o.personal)!.id;
    const ids: string[] = [];
    for (const name of ["Q1", "Q2", "Q3", "Q4"]) ids.push((await client.createInventoryItem(orgId, { name, mpn: `${name}-X`, manufacturer: "Acme" })).item.id);
    const mcp = await connect(createFabplaneMcpServer({ client, orgId }));
    try {
      const { tools } = await mcp.listTools();
      for (const n of ["inventory_photo_queue", "inventory_photo_claim", "inventory_photo_attach", "inventory_photo_release"]) assert.ok(tools.some((t) => t.name === n), n);
      const queue = (await mcp.callTool({ name: "inventory_photo_queue", arguments: {} })) as TextResult;
      assert.match(queue.content[0]!.text, /Photo queue: 4 queued, 4 available, 0 leased, 0 skipped/);
      assert.match(queue.content[0]!.text, /Q1 \(Acme Q1-X\)/);

      const claim = (await mcp.callTool({ name: "inventory_photo_claim", arguments: { limit: 4, worker: "claude" } })) as TextResult;
      assert.match(claim.content[0]!.text, /Leased 4 item\(s\)/);
      assert.match(claim.content[0]!.text, /leased by claude until/);

      const byUrl = (await mcp.callTool({ name: "inventory_photo_attach", arguments: { itemId: ids[0], imageUrl: `${api.origin}/img/part.png`, sourceUrl: "https://www.example.com/q1" } })) as TextResult;
      assert.equal(byUrl.isError, undefined, byUrl.content[0]!.text);
      assert.equal(api.state.inventory.get(ids[0]!)!["images"][0].sourceUrl, "https://www.example.com/q1");
      assert.equal(api.state.inventory.get(ids[0]!)!["images"][0].source, "web");

      const byData = (await mcp.callTool({ name: "inventory_photo_attach", arguments: { itemId: ids[1], data: JPEG_BYTES.toString("base64"), contentType: "image/jpeg" } })) as TextResult;
      assert.equal(byData.isError, undefined, byData.content[0]!.text);
      assert.equal(api.state.inventory.get(ids[1]!)!["images"][0].contentType, "image/jpeg");

      const neither = (await mcp.callTool({ name: "inventory_photo_attach", arguments: { itemId: ids[2] } })) as TextResult;
      assert.equal(neither.isError, true);
      const html = (await mcp.callTool({ name: "inventory_photo_attach", arguments: { itemId: ids[2], imageUrl: `${api.origin}/img/page.html` } })) as TextResult;
      assert.equal(html.isError, true);
      assert.match(html.content[0]!.text, /Not an accepted image/);

      const skip = (await mcp.callTool({ name: "inventory_photo_release", arguments: { itemId: ids[2], outcome: "not_found", note: "no photo" } })) as TextResult;
      assert.match(skip.content[0]!.text, /Skipped Q3/);
      const retry = (await mcp.callTool({ name: "inventory_photo_release", arguments: { itemId: ids[3], outcome: "retry" } })) as TextResult;
      assert.match(retry.content[0]!.text, /Released Q4 back to the queue/);
      const after = (await mcp.callTool({ name: "inventory_photo_queue", arguments: { include: "all" } })) as TextResult;
      assert.match(after.content[0]!.text, /Photo queue: 1 queued, 1 available, 0 leased, 1 skipped/);
    } finally {
      await mcp.close();
      await api.close();
    }
  });
});
