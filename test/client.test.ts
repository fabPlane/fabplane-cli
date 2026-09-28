import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FabplaneApiError, FabplaneClient, meUser } from "../src/index.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; rawBody: unknown };

function recorder(respond: (call: Call) => Response = () => json({})) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = undefined;
    if (typeof init.body === "string") body = headers["content-type"]?.includes("json") ? JSON.parse(init.body) : init.body;
    const call = { url: input, method: init.method ?? "GET", headers, body, rawBody: init.body };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const O = "org-1";
const C = "cart-1";
const I = "item-1";

/** [operationId, invoke, method, path+query, expected JSON body] */
const cases: Array<[string, (c: FabplaneClient) => Promise<unknown>, string, string, unknown?]> = [
  ["getMe", (c) => c.getMe(), "GET", "/v1/private/me"],
  ["listTokens", (c) => c.listTokens(), "GET", "/v1/private/tokens"],
  ["createToken", (c) => c.createToken({ name: "ci", expiresInDays: 30 }), "POST", "/v1/private/tokens", { name: "ci", expiresInDays: 30 }],
  ["deleteToken", (c) => c.deleteToken("t1"), "DELETE", "/v1/private/tokens/t1"],
  ["listOrgs", (c) => c.listOrgs(), "GET", "/v1/private/orgs"],
  ["createOrg", (c) => c.createOrg({ name: "Acme", slug: "acme" }), "POST", "/v1/private/orgs", { name: "Acme", slug: "acme" }],
  ["getOrg", (c) => c.getOrg(O), "GET", `/v1/private/orgs/${O}`],
  ["updateOrg", (c) => c.updateOrg(O, { domainJoin: { domain: "acme.com", enabled: true } }), "PATCH", `/v1/private/orgs/${O}`, { domainJoin: { domain: "acme.com", enabled: true } }],
  ["deleteOrg", (c) => c.deleteOrg(O), "DELETE", `/v1/private/orgs/${O}`],
  ["listJoinableOrgs", (c) => c.listJoinableOrgs(), "GET", "/v1/private/orgs/joinable"],
  ["joinOrg", (c) => c.joinOrg(O), "POST", `/v1/private/orgs/${O}/join`],
  ["listMembers", (c) => c.listMembers(O), "GET", `/v1/private/orgs/${O}/members`],
  ["updateMember", (c) => c.updateMember(O, "u1", { role: "admin" }), "PATCH", `/v1/private/orgs/${O}/members/u1`, { role: "admin" }],
  ["removeMember", (c) => c.removeMember(O, "u1"), "DELETE", `/v1/private/orgs/${O}/members/u1`],
  ["listInvites", (c) => c.listInvites(O), "GET", `/v1/private/orgs/${O}/invites`],
  ["createInvite", (c) => c.createInvite(O, { email: "a@b.c", role: "admin" }), "POST", `/v1/private/orgs/${O}/invites`, { email: "a@b.c", role: "admin" }],
  ["revokeInvite", (c) => c.revokeInvite(O, "inv1"), "DELETE", `/v1/private/orgs/${O}/invites/inv1`],
  ["getInvite", (c) => c.getInvite("tok 1"), "GET", "/v1/private/invites/tok%201"],
  ["acceptInvite", (c) => c.acceptInvite("tok1"), "POST", "/v1/private/invites/tok1/accept"],
  ["listDestinations", (c) => c.listDestinations(O), "GET", `/v1/private/orgs/${O}/destinations`],
  ["createDestination", (c) => c.createDestination(O, { name: "DigiKey TH", url: "https://www.digikey.co.th", baseId: "builtin:digikey" }), "POST", `/v1/private/orgs/${O}/destinations`, { name: "DigiKey TH", url: "https://www.digikey.co.th", baseId: "builtin:digikey" }],
  ["deleteDestination", (c) => c.deleteDestination(O, "d1"), "DELETE", `/v1/private/orgs/${O}/destinations/d1`],
  ["listCarts", (c) => c.listCarts(O, { repo: "https://github.com/a/b", projectId: "p1" }), "GET", `/v1/private/orgs/${O}/carts?repo=https%3A%2F%2Fgithub.com%2Fa%2Fb&projectId=p1`],
  ["createCart", (c) => c.createCart(O, { name: "Rev A", repos: ["https://github.com/a/b"] }), "POST", `/v1/private/orgs/${O}/carts`, { name: "Rev A", repos: ["https://github.com/a/b"] }],
  ["getCart", (c) => c.getCart(O, C), "GET", `/v1/private/orgs/${O}/carts/${C}`],
  ["updateCart", (c) => c.updateCart(O, C, { projectId: null }), "PATCH", `/v1/private/orgs/${O}/carts/${C}`, { projectId: null }],
  ["deleteCart", (c) => c.deleteCart(O, C), "DELETE", `/v1/private/orgs/${O}/carts/${C}`],
  ["addCartItems", (c) => c.addCartItems(O, C, [{ mpn: "NE555", quantity: 2 }]), "POST", `/v1/private/orgs/${O}/carts/${C}/items`, { items: [{ mpn: "NE555", quantity: 2 }] }],
  ["replaceCartItems", (c) => c.replaceCartItems(O, C, [{ quantity: 1 }], "kicad-bom"), "PUT", `/v1/private/orgs/${O}/carts/${C}/items`, { items: [{ quantity: 1 }], source: "kicad-bom" }],
  ["updateCartItem", (c) => c.updateCartItem(O, C, I, { status: "ordered" }), "PATCH", `/v1/private/orgs/${O}/carts/${C}/items/${I}`, { status: "ordered" }],
  ["deleteCartItem", (c) => c.deleteCartItem(O, C, I), "DELETE", `/v1/private/orgs/${O}/carts/${C}/items/${I}`],
  ["exportCartCsv", (c) => c.exportCartCsv(O, C, { destinationId: "builtin:lcsc" }), "GET", `/v1/private/orgs/${O}/carts/${C}/export.csv?destinationId=builtin%3Alcsc`],
  ["listInventory", (c) => c.listInventory(O, { q: "555", limit: 10 }), "GET", `/v1/private/orgs/${O}/inventory?q=555&limit=10`],
  ["createInventoryItem", (c) => c.createInventoryItem(O, { name: "NE555", quantity: 3 }), "POST", `/v1/private/orgs/${O}/inventory`, { name: "NE555", quantity: 3 }],
  ["bulkUpsertInventory", (c) => c.bulkUpsertInventory(O, [{ name: "x", externalId: "e1" }]), "POST", `/v1/private/orgs/${O}/inventory/bulk`, { items: [{ name: "x", externalId: "e1" }] }],
  ["getInventoryItem", (c) => c.getInventoryItem(O, I), "GET", `/v1/private/orgs/${O}/inventory/${I}`],
  ["updateInventoryItem", (c) => c.updateInventoryItem(O, I, { location: "A3" }), "PATCH", `/v1/private/orgs/${O}/inventory/${I}`, { location: "A3" }],
  ["deleteInventoryItem", (c) => c.deleteInventoryItem(O, I), "DELETE", `/v1/private/orgs/${O}/inventory/${I}`],
  ["adjustInventory", (c) => c.adjustInventory(O, I, -2, "used"), "POST", `/v1/private/orgs/${O}/inventory/${I}/adjust`, { delta: -2, reason: "used" }],
  ["uploadInventoryImage", (c) => c.uploadInventoryImage(O, I, { data: new Uint8Array([1, 2, 3]), contentType: "image/png" }), "POST", `/v1/private/orgs/${O}/inventory/${I}/images`],
  ["getInventoryImage", (c) => c.getInventoryImage(O, I, "img1"), "GET", `/v1/private/orgs/${O}/inventory/${I}/images/img1`],
  ["deleteInventoryImage", (c) => c.deleteInventoryImage(O, I, "img1"), "DELETE", `/v1/private/orgs/${O}/inventory/${I}/images/img1`],
  // Existing endpoints.
  ["me", (c) => c.me(), "GET", "/v1/auth/me"],
  ["logout", (c) => c.logout(), "DELETE", "/v1/auth/session"],
  ["getSettings", (c) => c.getSettings(), "GET", "/v1/private/settings"],
  ["putSettings", (c) => c.putSettings({ schema: 1, updatedAt: 5 }), "PUT", "/v1/private/settings", { schema: 1, updatedAt: 5 }],
  ["publicCatalog", (c) => c.publicCatalog("led"), "GET", "/v1/public/catalog?q=led"],
  ["config", (c) => c.config(), "GET", "/v1/config"],
  ["sendPush", (c) => c.sendPush([{ to: "tok", title: "t", body: "b" }]), "POST", "/v1/private/push", { messages: [{ to: "tok", title: "t", body: "b" }] }],
  ["getPushJob", (c) => c.getPushJob("j1"), "GET", "/v1/private/push/j1"],
];

describe("FabplaneClient request shapes", () => {
  for (const [name, invoke, method, path, body] of cases) {
    it(`${name} → ${method} ${path}`, async () => {
      const { calls, fetch } = recorder((call) => (call.url.includes("/images/img1") && call.method === "GET" ? new Response(null, { status: 302, headers: { location: "https://s.example/x" } }) : json({ ok: true })));
      const client = new FabplaneClient({ origin: "https://api.example.test/", token: "fpk_abc", fetch });
      await invoke(client);
      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.equal(call.method, method);
      assert.equal(call.url, `https://api.example.test${path}`);
      const anonymous = ["publicCatalog", "config"].includes(name);
      assert.equal(call.headers["authorization"], anonymous ? undefined : "Bearer fpk_abc");
      if (body !== undefined) assert.deepEqual(call.body, body);
    });
  }

  it("covers every documented operation plus the pre-contract endpoints", () => {
    assert.ok(cases.length >= 42 + 8);
  });
});

describe("FabplaneClient responses and errors", () => {
  it("returns the JSON envelope as-is", async () => {
    const { fetch } = recorder(() => json({ orgs: [{ id: "o" }] }));
    const res = await new FabplaneClient({ token: "t", fetch }).listOrgs();
    assert.deepEqual(res, { orgs: [{ id: "o" }] });
  });

  it("defaults to the production origin", async () => {
    const { calls, fetch } = recorder();
    await new FabplaneClient({ fetch }).config();
    assert.equal(calls[0]!.url, "https://api.fabplane.com/v1/config");
  });

  it("resolves 204 to undefined", async () => {
    const { fetch } = recorder(() => new Response(null, { status: 204 }));
    assert.equal(await new FabplaneClient({ token: "t", fetch }).deleteCart("o", "c"), undefined);
  });

  it("returns CSV text for exportCartCsv", async () => {
    const { calls, fetch } = recorder(() => new Response("destination,kind\nbuiltin:jlcpcb,part\n", { headers: { "content-type": "text/csv" } }));
    const csv = await new FabplaneClient({ token: "t", fetch }).exportCartCsv("o", "c");
    assert.match(csv, /^destination,kind/);
    assert.equal(calls[0]!.headers["accept"], "text/csv");
  });

  it("maps error bodies to FabplaneApiError", async () => {
    const { fetch } = recorder(() => json({ error: "conflict", message: "quantity would go below zero" }, 409));
    await assert.rejects(new FabplaneClient({ token: "t", fetch }).adjustInventory("o", "i", -9), (err: unknown) => {
      assert.ok(err instanceof FabplaneApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "conflict");
      assert.equal(err.message, "quantity would go below zero");
      assert.deepEqual(err.body, { error: "conflict", message: "quantity would go below zero" });
      return true;
    });
  });

  it("maps the 501 server-AI answer", async () => {
    const { fetch } = recorder(() => json({ error: "server_ai_unavailable", message: "Server-side AI processing is not available yet; extract fields locally and send them" }, 501));
    await assert.rejects(new FabplaneClient({ token: "t", fetch }).createInventoryItem("o", { name: "x", serverAiProcessing: true }), (err: unknown) => err instanceof FabplaneApiError && err.status === 501 && err.code === "server_ai_unavailable");
  });

  it("uses http_<status> when the error body is not JSON", async () => {
    const { fetch } = recorder(() => new Response("Bad gateway", { status: 502 }));
    await assert.rejects(new FabplaneClient({ token: "t", fetch }).listOrgs(), (err: unknown) => err instanceof FabplaneApiError && err.code === "http_502" && /Bad gateway/.test(err.message));
  });

  it("getSettings returns null on 404", async () => {
    const { fetch } = recorder(() => json({ error: "not_found" }, 404));
    assert.equal(await new FabplaneClient({ token: "t", fetch }).getSettings(), null);
  });

  it("getInventoryImage returns the redirect target without following it", async () => {
    const { calls, fetch } = recorder(() => new Response(null, { status: 302, headers: { location: "https://storage.example/x?sig=1" } }));
    const res = await new FabplaneClient({ token: "t", fetch }).getInventoryImage("o", "i", "img");
    assert.deepEqual(res, { url: "https://storage.example/x?sig=1" });
    assert.equal(calls.length, 1);
  });
});

describe("multipart uploads", () => {
  it("createInventoryItem with images sends multipart item + image fields", async () => {
    const { calls, fetch } = recorder(() => json({ item: { id: "i" } }, 201));
    await new FabplaneClient({ token: "t", fetch }).createInventoryItem("o", { name: "Cap", quantity: 10 }, [
      { data: new Uint8Array([137, 80, 78, 71]), contentType: "image/png", filename: "a.png" },
      { data: new Blob([new Uint8Array([255, 216])], { type: "image/jpeg" }), contentType: "image/jpeg" },
    ]);
    const call = calls[0]!;
    assert.equal(call.headers["content-type"], undefined, "fetch sets the multipart boundary");
    assert.ok(call.rawBody instanceof FormData);
    const form = call.rawBody as FormData;
    assert.deepEqual(JSON.parse(String(form.get("item"))), { name: "Cap", quantity: 10 });
    const images = form.getAll("image") as File[];
    assert.equal(images.length, 2);
    assert.equal(images[0]!.name, "a.png");
    assert.equal(images[0]!.type, "image/png");
    assert.equal(images[0]!.size, 4);
    assert.equal(images[1]!.name, "image-2.jpg");
    assert.equal(images[1]!.type, "image/jpeg");
  });

  it("uploadInventoryImage sends one image field", async () => {
    const { calls, fetch } = recorder(() => json({ image: { id: "img" } }, 201));
    await new FabplaneClient({ token: "t", fetch }).uploadInventoryImage("o", "i", { data: new Uint8Array([1]).buffer, contentType: "image/webp" });
    const form = calls[0]!.rawBody as FormData;
    const file = form.get("image") as File;
    assert.equal(file.type, "image/webp");
    assert.equal(file.name, "image.webp");
  });
});

describe("device flow", () => {
  it("startDeviceLogin posts the RFC 8628 body without a bearer", async () => {
    const { calls, fetch } = recorder(() =>
      json({ device_code: "dc", user_code: "UC", verification_uri: "https://app/device", verification_uri_complete: "https://app/device?c=UC", expires_in: 600, interval: 5 }),
    );
    const client = new FabplaneClient({ token: "old", fetch });
    const res = await client.startDeviceLogin({ clientLabel: "test" });
    assert.equal(res.user_code, "UC");
    assert.equal(calls[0]!.url, "https://api.fabplane.com/v1/auth/device/code");
    assert.deepEqual(calls[0]!.body, { client_id: "fabplane-cli", client_label: "test" });
    assert.equal(calls[0]!.headers["authorization"], undefined);
  });

  it("clientId is configurable", async () => {
    const { calls, fetch } = recorder(() => json({ device_code: "dc", user_code: "UC", verification_uri: "u", expires_in: 1, interval: 1 }));
    const res = await new FabplaneClient({ fetch, clientId: "fabdesk" }).startDeviceLogin();
    assert.equal((calls[0]!.body as { client_id: string }).client_id, "fabdesk");
    assert.equal(res.verification_uri_complete, "u");
  });

  it("pollDeviceToken maps pending / slow_down / errors / token", async () => {
    const answers = [json({ error: "authorization_pending" }, 400), json({ error: "slow_down" }, 400), json({ error: "access_denied", error_description: "no" }, 400), json({ access_token: "fpd_x", expires_in: 60 })];
    const { calls, fetch } = recorder(() => answers.shift()!);
    const c = new FabplaneClient({ fetch });
    assert.deepEqual(await c.pollDeviceToken("dc"), { status: "pending" });
    assert.deepEqual(await c.pollDeviceToken("dc"), { status: "slow_down" });
    assert.deepEqual(await c.pollDeviceToken("dc"), { status: "error", error: "access_denied", description: "no" });
    assert.deepEqual(await c.pollDeviceToken("dc"), { status: "token", token: { access_token: "fpd_x", token_type: "Bearer", expires_in: 60 } });
    assert.deepEqual(calls[0]!.body, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dc", client_id: "fabplane-cli" });
  });

  it("waitForDeviceToken honours slow_down and returns the token", async () => {
    const answers = [json({ error: "authorization_pending" }, 400), json({ error: "slow_down" }, 400), json({ access_token: "fpd_y", expires_in: 60 })];
    const { fetch } = recorder(() => answers.shift()!);
    const sleeps: number[] = [];
    const token = await new FabplaneClient({ fetch }).waitForDeviceToken(
      { device_code: "dc", user_code: "u", verification_uri: "v", verification_uri_complete: "v", expires_in: 600, interval: 2 },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.equal(token.access_token, "fpd_y");
    assert.deepEqual(sleeps, [2000, 2000, 7000]);
  });

  it("waitForDeviceToken throws on denial", async () => {
    const { fetch } = recorder(() => json({ error: "access_denied" }, 400));
    await assert.rejects(
      new FabplaneClient({ fetch }).waitForDeviceToken({ device_code: "dc", user_code: "u", verification_uri: "v", verification_uri_complete: "v", expires_in: 600, interval: 1 }, { sleep: async () => {} }),
      (err: unknown) => err instanceof FabplaneApiError && err.code === "access_denied",
    );
  });

  it("loginWithPassword refuses production", async () => {
    const { calls, fetch } = recorder();
    await assert.rejects(new FabplaneClient({ fetch }).loginWithPassword({ email: "a", password: "b" }), /not available on production/);
    assert.equal(calls.length, 0);
  });
});

describe("meUser", () => {
  it("flattens the current and the older getMe shapes", () => {
    assert.deepEqual(meUser({ principal: { subject: "s", handle: "maya" }, email: "m@x.test", emailVerified: true, personalOrgId: "o1" }), { subject: "s", handle: "maya", email: "m@x.test", emailVerified: true, personalOrgId: "o1" });
    assert.deepEqual(meUser({ principal: null, user: { subject: "s", personalOrgId: "o2" } }), { subject: "s", personalOrgId: "o2" });
    assert.equal(meUser({ principal: null }), null);
  });
});
