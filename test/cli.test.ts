import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { FabdeskClient, VERSION, runCli, type CliIo, type FabplaneMcpOptions } from "../src/index.js";
import { OTHER_TOKEN, USER_TOKEN, startFakeApi, type FakeApi } from "./fake-api.js";
import { DAEMON_TOKEN, startFakeDaemon } from "./fake-daemon.js";

let api: FakeApi;
let dir: string;
let credFile: string;

type Run = { code: number; stdout: string; stderr: string; json(): any };

async function cli(argv: string[], opts: { env?: Record<string, string>; io?: Partial<CliIo> } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { HOME: dir, FABPLANE_CREDENTIALS_FILE: credFile, FABPLANE_API_ORIGIN: api.origin, ...(opts.env ?? {}) },
    cwd: dir,
    sleep: async () => {},
    ...(opts.io ?? {}),
  });
  const stdout = out.join("\n");
  return { code, stdout, stderr: err.join("\n"), json: () => JSON.parse(stdout) };
}

async function login(token = USER_TOKEN): Promise<void> {
  const r = await cli(["login", "--token", token]);
  assert.equal(r.code, 0, r.stderr);
}

before(async () => {
  api = await startFakeApi();
});
after(() => api.close());
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fabplane-cli-"));
  credFile = join(dir, "config", "credentials.json");
});

describe("argv handling", () => {
  it("help, version and unknown commands", async () => {
    const help = await cli(["help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: fabplane <command>/);
    for (const c of ["login", "orgs list", "carts import", "inventory adjust", "mcp", "desktop call", "api"]) assert.ok(help.stdout.includes(`  ${c}`), c);
    assert.match((await cli([])).stdout, /Commands:/);
    assert.equal((await cli(["--version"])).stdout, VERSION);
    assert.equal((await cli(["version", "--json"])).json().version, VERSION);
    assert.match((await cli(["help", "carts"])).stdout, /carts export <cartId>/);
    assert.match((await cli(["carts", "show", "--help"])).stdout, /fabplane carts show <cartId>/);
    const unknown = await cli(["frobnicate"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown command "frobnicate"/);
    const group = await cli(["carts"]);
    assert.equal(group.code, 2);
    assert.match(group.stderr, /carts list/);
  });

  it("rejects unknown flags with usage", async () => {
    const r = await cli(["orgs", "list", "--bogus"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Unknown option '--bogus'/);
    assert.match(r.stderr, /Usage: fabplane orgs list/);
  });

  it("global flags may come before the command", async () => {
    await login();
    const r = await cli(["--json", "--org", "maya", "carts", "list"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().carts, []);
  });

  it("requires login for API commands", async () => {
    const r = await cli(["orgs", "list"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Not logged in to http:\/\/127\.0\.0\.1:\d+\. Run `fabplane login`/);
  });
});

describe("auth commands", () => {
  it("login --token stores a 0600 profile; whoami and logout", async () => {
    const r = await cli(["login", "--token", OTHER_TOKEN]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Logged in to http:\/\/127\.0\.0\.1:\d+ as bob\./);
    const file = JSON.parse(await readFile(credFile, "utf8"));
    assert.equal(file.currentOrigin, api.origin);
    assert.equal(file.profiles[api.origin].token, OTHER_TOKEN);
    assert.equal(file.profiles[api.origin].tokenKind, "api");
    if (process.platform !== "win32") assert.equal((await stat(credFile)).mode & 0o777, 0o600);

    // The stored origin is used when FABPLANE_API_ORIGIN is unset.
    const who = await cli(["whoami", "--json"], { env: { FABPLANE_API_ORIGIN: "" } });
    assert.equal(who.code, 0, who.stderr);
    assert.equal(who.json().user.handle, "bob");
    assert.equal(who.json().origin, api.origin);
    assert.equal(who.json().tokenSource, "file");
    assert.match((await cli(["whoami"])).stdout, /user: +bob/);

    const out = await cli(["logout"]);
    assert.match(out.stdout, /Logged out of .*Personal API tokens stay valid/);
    assert.equal(api.state.tokens.has(OTHER_TOKEN), true, "fpk_ tokens are not revoked by logout");
    assert.match((await cli(["logout"])).stdout, /No stored credentials/);
  });

  it("login rejects a bad token", async () => {
    const r = await cli(["login", "--token", "fpk_nope"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 401 unauthorized/);
    assert.equal(existsSync(credFile), false);
  });

  it("device-flow login prints the URL and code to stderr and opens the browser", async () => {
    const opened: string[] = [];
    const r = await cli(["login"], { io: { openUrl: (u) => opened.push(u) } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /open http:\/\/127\.0\.0\.1:\d+\/device\?code=ABCD-EFGH/);
    assert.match(r.stderr, /confirm the code: ABCD-EFGH/);
    assert.equal(opened.length, 1);
    assert.match(r.stdout, /as maya/);
    const file = JSON.parse(await readFile(credFile, "utf8"));
    assert.equal(file.profiles[api.origin].tokenKind, "device");
    assert.ok(file.profiles[api.origin].expiresAt);
    // --no-browser does not open anything.
    const opened2: string[] = [];
    assert.equal((await cli(["login", "--no-browser"], { io: { openUrl: (u) => opened2.push(u) } })).code, 0);
    assert.equal(opened2.length, 0);
    // Device-token logout revokes the session.
    await cli(["logout"]);
    assert.equal(api.state.tokens.has(USER_TOKEN), false);
    api.state.tokens.set(USER_TOKEN, { userId: [...api.state.users.values()].find((u) => u["handle"] === "maya")!["id"] });
  });

  it("password login (staging/local accounts)", async () => {
    const r = await cli(["login", "--email", "maya@example.com", "--password", "pw"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /as maya/);
    const bad = await cli(["login", "--email", "maya@example.com", "--password", "wrong"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Invalid email or password/);
  });

  it("FABPLANE_TOKEN works without a stored login", async () => {
    const r = await cli(["orgs", "list", "--json"], { env: { FABPLANE_TOKEN: USER_TOKEN } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().orgs[0].slug, "maya");
  });

  it("dashboard prints the dashboard URL", async () => {
    assert.equal((await cli(["dashboard"], { env: { FABPLANE_API_ORIGIN: "https://api.fabplane.com" } })).stdout, "https://app.fabplane.com/dashboard");
    const opened: string[] = [];
    const r = await cli(["dashboard", "--open", "--origin", "http://localhost:4000"], { io: { openUrl: (u) => opened.push(u) } });
    assert.equal(r.stdout, "http://localhost:5173/dashboard");
    assert.deepEqual(opened, ["http://localhost:5173/dashboard"]);
  });
});

describe("orgs and tokens", () => {
  it("orgs list/create/use/members/invite/invites/role/joinable/join/accept", async () => {
    await login();
    const list = await cli(["orgs", "list"]);
    assert.match(list.stdout, /^\s+SLUG/m);
    assert.match(list.stdout, /\* +maya/);
    const created = await cli(["orgs", "create", "Lab Team", "--slug", "lab-team", "--json"]);
    assert.equal(created.code, 0, created.stderr);
    const org = created.json().org;
    assert.equal(org.role, "owner");
    assert.equal((await cli(["orgs", "create", "Dup", "--slug", "lab-team"])).code, 1);

    const use = await cli(["orgs", "use", "lab-team"]);
    assert.match(use.stdout, /Default org is now Lab Team/);
    assert.equal(JSON.parse(await readFile(credFile, "utf8")).profiles[api.origin].defaultOrgId, org.id);
    assert.match((await cli(["orgs", "list"])).stdout, /\* +lab-team/);
    assert.equal((await cli(["orgs", "use", "nope"])).code, 2);

    const members = await cli(["orgs", "members", "--json"]);
    assert.equal(members.json().members[0].handle, "maya");
    const invite = await cli(["orgs", "invite", "--email", "bob@example.com", "--role", "admin", "--days", "3"]);
    assert.equal(invite.code, 0, invite.stderr);
    assert.match(invite.stdout, /Invite link \(admin for bob@example\.com/);
    const url = invite.stdout.split("\n").at(-1)!;
    assert.match((await cli(["orgs", "invites"])).stdout, /bob@example\.com/);
    assert.equal((await cli(["orgs", "invite", "--role", "owner"])).code, 2);

    const accepted = await cli(["orgs", "accept", url], { env: { FABPLANE_TOKEN: OTHER_TOKEN, FABPLANE_CREDENTIALS_FILE: join(dir, "other.json") } });
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /Joined Lab Team \(lab-team\) as admin/);
    const bobId = [...api.state.users.values()].find((u) => u["handle"] === "bob")!["id"];
    const role = await cli(["orgs", "role", bobId, "member"]);
    assert.match(role.stdout, /bob is now member/);

    const joinable = await cli(["orgs", "joinable", "--json"]);
    const acme = joinable.json().orgs.find((o: { slug: string }) => o.slug === "acme");
    assert.ok(acme);
    assert.match((await cli(["orgs", "join", acme.id])).stdout, /Joined Acme Hardware \(acme\) as member/);
  });

  it("FABPLANE_ORG and --org override the stored default", async () => {
    await login();
    await cli(["orgs", "create", "Other", "--slug", "other-org"]);
    await cli(["carts", "create", "In other", "--org", "other-org"]);
    assert.match((await cli(["carts", "list"], { env: { FABPLANE_ORG: "other-org" } })).stdout, /In other/);
    assert.match((await cli(["carts", "list"])).stdout, /\(none\)/);
  });

  it("tokens create/list/revoke", async () => {
    await login();
    const created = await cli(["tokens", "create", "ci", "--days", "30"]);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /^fpk_[0-9a-f]+\n/);
    assert.match(created.stdout, /not shown again/);
    const list = await cli(["tokens", "list", "--json"]);
    const token = list.json().tokens[0];
    assert.equal(token.name, "ci");
    assert.match((await cli(["tokens", "revoke", token.id])).stdout, /Revoked token/);
    assert.deepEqual((await cli(["tokens", "list", "--json"])).json().tokens, []);
    const missing = await cli(["tokens", "revoke", token.id]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /HTTP 404 not_found/);
  });
});

describe("destinations and carts", () => {
  it("destinations list/add", async () => {
    await login();
    assert.match((await cli(["destinations", "list"])).stdout, /builtin:digikey +DigiKey +distributor/);
    const add = await cli(["destinations", "add", "--name", "DigiKey Thailand", "--url", "https://www.digikey.co.th", "--base", "builtin:digikey", "--json"]);
    assert.equal(add.code, 0, add.stderr);
    assert.equal(add.json().destination.baseId, "builtin:digikey");
    assert.equal((await cli(["destinations", "add", "--name", "x"])).code, 2);
    assert.match((await cli(["destinations", "list"])).stdout, /DigiKey Thailand/);
  });

  it("carts create/list/add/show/import/export/delete", async () => {
    await login();
    const created = await cli(["carts", "create", "Rev A", "--repo", "https://github.com/acme/board", "--repo", "https://github.com/acme/fw", "--project", "p1", "--json"]);
    assert.equal(created.code, 0, created.stderr);
    const cart = created.json().cart;
    assert.deepEqual(cart.repos, ["https://github.com/acme/board", "https://github.com/acme/fw"]);
    assert.match((await cli(["carts", "list", "--repo", "https://github.com/acme/fw"])).stdout, /Rev A/);
    assert.match((await cli(["carts", "list", "--project", "nope"])).stdout, /\(none\)/);

    const add = await cli(["carts", "add", cart.id, "--mpn", "NE555P", "--qty", "5", "--refs", "U1,U2", "--dest", "builtin:lcsc", "--price", "0.12", "--currency", "USD"]);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, /Added 5× NE555P → builtin:lcsc/);
    const lastPost = api.requests.filter((r) => r.method === "POST" && r.path.endsWith("/items")).at(-1)!;
    assert.deepEqual(lastPost.body, { items: [{ quantity: 5, mpn: "NE555P", destinationId: "builtin:lcsc", refs: ["U1", "U2"], unitPrice: 0.12, currency: "USD" }] });
    assert.equal((await cli(["carts", "add", cart.id, "--mpn", "x"])).code, 2);
    assert.equal((await cli(["carts", "add", cart.id, "--mpn", "x", "--qty", "1.5"])).code, 2);

    await writeFile(join(dir, "bom.csv"), 'Designator,Qty,Manufacturer Part Number,Mfr,LCSC Part,Notes\n"R1,R2",2,RC0603FR-0710KL,Yageo,C98220,"10k, 1%"\nC1,1,CL10A106KP8NNNC,Samsung,C19702,\n');
    const importCsv = await cli(["carts", "import", cart.id, "bom.csv"]);
    assert.equal(importCsv.code, 0, importCsv.stderr);
    assert.match(importCsv.stdout, /Added 2 item/);
    const csvPost = api.requests.filter((r) => r.method === "POST" && r.path.endsWith("/items")).at(-1)!;
    assert.deepEqual((csvPost.body as { items: unknown[] }).items[0], { refs: ["R1", "R2"], quantity: 2, mpn: "RC0603FR-0710KL", manufacturer: "Yageo", sku: "C98220", notes: "10k, 1%" });

    await writeFile(join(dir, "named.csv"), "destination,mpn,quantity\nLCSC,C1,1\n");
    assert.match((await cli(["carts", "import", cart.id, "named.csv"])).stdout, /Added 1 item/);
    const namedPost = api.requests.filter((r) => r.method === "POST" && r.path.endsWith("/items")).at(-1)!;
    assert.equal((namedPost.body as { items: Array<{ destinationId: string }> }).items[0]!.destinationId, "builtin:lcsc");
    await writeFile(join(dir, "unknown.csv"), "destination,mpn,quantity\nNowhere,C1,1\n");
    assert.match((await cli(["carts", "import", cart.id, "unknown.csv"])).stderr, /Unknown destination "Nowhere"/);
    const lastItems = [...api.state.carts.get(cart.id)!["items"]];
    api.state.carts.get(cart.id)!["items"] = lastItems.filter((i: { mpn?: string }) => i.mpn !== "C1");
    await writeFile(join(dir, "items.json"), JSON.stringify({ items: [{ mpn: "LED", quantity: 3 }] }));
    assert.match((await cli(["carts", "import", cart.id, "items.json"])).stdout, /Added 1 item/);

    const show = await cli(["carts", "show", cart.id]);
    assert.match(show.stdout, /cart: +Rev A/);
    assert.match(show.stdout, /NE555P/);
    assert.match(show.stdout, /builtin:jlcpcb: 3 line\(s\), 6 pcs/);

    const csv = await cli(["carts", "export", cart.id, "--dest", "builtin:lcsc"]);
    assert.match(csv.stdout, /^destination,kind,mpn/);
    assert.equal(csv.stdout.trim().split("\n").length, 2);
    const written = await cli(["carts", "export", cart.id, "-o", "out.csv"]);
    assert.equal(written.code, 0, written.stderr);
    assert.match(readFileSync(join(dir, "out.csv"), "utf8"), /RC0603FR/);

    await writeFile(join(dir, "replace.jsonl"), '{"mpn":"ONLY","quantity":1}\n');
    const replaced = await cli(["carts", "import", cart.id, "replace.jsonl", "--replace", "--source", "kicad"]);
    assert.match(replaced.stdout, /Replaced items of Rev A: 1 line/);
    assert.equal((await cli(["carts", "import", cart.id, "missing.csv"])).code, 1);

    assert.match((await cli(["carts", "delete", cart.id])).stdout, /Deleted cart/);
    assert.equal((await cli(["carts", "show", cart.id])).code, 1);
  });
});

describe("inventory", () => {
  it("add (with images and attributes), list, show, adjust, delete", async () => {
    await login();
    await writeFile(join(dir, "photo.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const add = await cli(["inventory", "add", "--name", "10k resistor", "--mpn", "RC0603", "--qty", "100", "--location", "Drawer A3", "--tag", "passive", "--tag", "0603", "--attr", "resistance=10k", "--attr", "tolerance_pct=1", "--attr", "rohs=true", "--image", "photo.png", "--json"]);
    assert.equal(add.code, 0, add.stderr);
    const item = add.json().item;
    assert.equal(item.images.length, 1);
    assert.equal(item.images[0].contentType, "image/png");
    assert.deepEqual(item.attributes, { resistance: "10k", tolerance_pct: 1, rohs: true });
    assert.deepEqual(item.tags, ["passive", "0603"]);
    assert.equal(item.source, "fabplane-cli");
    const req = api.requests.filter((r) => r.path.endsWith("/inventory") && r.method === "POST").at(-1)!;
    assert.match(req.contentType ?? "", /multipart\/form-data/);

    assert.equal((await cli(["inventory", "add", "--name", "x", "--image", "a.bmp"])).code, 2);
    assert.equal((await cli(["inventory", "add", "--name", "x", "--attr", "novalue"])).code, 2);

    assert.match((await cli(["inventory", "list", "--q", "rc0603"])).stdout, /10k resistor/);
    const show = await cli(["inventory", "show", item.id]);
    assert.match(show.stdout, /quantity: +100 pcs/);
    assert.match(show.stdout, /resistance: +10k/);

    const adj = await cli(["inventory", "adjust", item.id, "-30", "--reason", "built"]);
    assert.equal(adj.code, 0, adj.stderr);
    assert.match(adj.stdout, /10k resistor: 70 pcs \(-30\)/);
    assert.match((await cli(["inventory", "adjust", item.id, "+5"])).stdout, /75 pcs \(\+5\)/);
    const tooMany = await cli(["inventory", "adjust", item.id, "-500"]);
    assert.equal(tooMany.code, 1);
    assert.match(tooMany.stderr, /quantity would go below zero \(HTTP 409 conflict\)/);
    assert.equal((await cli(["inventory", "adjust", item.id, "0"])).code, 2);

    assert.match((await cli(["inventory", "delete", item.id])).stdout, /Deleted/);
  });

  it("--server-ai surfaces the 501 clearly and stores nothing", async () => {
    await login();
    const before = api.state.inventory.size;
    const r = await cli(["inventory", "add", "--name", "mystery part", "--server-ai"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Server-side AI processing is not available yet \(HTTP 501 server_ai_unavailable\)/);
    assert.match(r.stderr, /Nothing was stored\. Extract the fields locally/);
    assert.equal(api.state.inventory.size, before);
    const j = await cli(["inventory", "add", "--name", "m", "--server-ai", "--json"]);
    assert.equal(JSON.parse(j.stderr).error, "server_ai_unavailable");
  });

  it("import upserts JSONL in chunks of 500 keyed by externalId", async () => {
    await login();
    const lines = Array.from({ length: 1203 }, (_, i) => JSON.stringify({ name: `Part ${i}`, quantity: i % 7, externalId: `row-${i}` }));
    lines.splice(10, 0, "", "// comment");
    lines.push(JSON.stringify({ name: "No external id", mpn: "X1" }));
    await writeFile(join(dir, "parts.jsonl"), lines.join("\n"));
    const r = await cli(["inventory", "import", "parts.jsonl", "--source", "openclaw"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Imported 1204 item\(s\): 1204 created, 0 updated/);
    const bulk = api.requests.filter((x) => x.path.endsWith("/inventory/bulk"));
    assert.deepEqual(bulk.map((b) => (b.body as { items: unknown[] }).items.length), [500, 500, 204]);
    assert.match(r.stderr, /batch 3\/3/);
    const again = await cli(["inventory", "import", "parts.jsonl", "--source", "openclaw", "--json"]);
    assert.deepEqual(again.json(), { ok: true, total: 1204, created: 0, updated: 1204 });

    const page = await cli(["inventory", "list", "--limit", "500", "--json"]);
    assert.equal(page.json().items.length, 500);
    assert.equal(page.json().nextCursor, "500");
    const all = await cli(["inventory", "list", "--limit", "200", "--all", "--json"]);
    assert.equal(all.json().items.length, 1204);
    assert.equal(all.json().nextCursor, null);

    await writeFile(join(dir, "bad.jsonl"), '{"quantity":1}\n');
    assert.match((await cli(["inventory", "import", "bad.jsonl"])).stderr, /Line 1: "name" is required/);
    await writeFile(join(dir, "broken.jsonl"), "{nope\n");
    assert.match((await cli(["inventory", "import", "broken.jsonl"])).stderr, /Line 1: invalid JSON/);
  });
});

describe("raw api, mcp and desktop", () => {
  it("api escape hatch", async () => {
    await login();
    const r = await cli(["api", "GET", "/v1/private/orgs"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).orgs[0].slug, "maya");
    const post = await cli(["api", "post", "v1/private/orgs", '{"name":"Via API","slug":"via-api"}', "--json"]);
    assert.equal(post.json().status, 201);
    const q = await cli(["api", "GET", "/v1/public/catalog?q=led", "--anonymous"]);
    assert.equal(JSON.parse(q.stdout).projects[0].q, "led");
    const missing = await cli(["api", "GET", "/v1/private/nope"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /HTTP 404/);
    assert.equal((await cli(["api", "POST", "/v1/private/orgs", "{bad"])).code, 2);
  });

  it("mcp wires the client, lazy default org and --desktop", async () => {
    await login();
    let captured: FabplaneMcpOptions | undefined;
    const r = await cli(["mcp", "--desktop"], { io: { runMcp: async (o) => void (captured = o), fabdesk: new FabdeskClient({ baseUrl: "http://x", token: "t" }) } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", "nothing may be written to stdout in MCP mode");
    assert.equal(captured?.client.origin, api.origin);
    assert.ok(captured?.desktop);
    assert.equal(typeof captured?.orgId, "function");
    const orgId = await (captured!.orgId as () => Promise<string>)();
    assert.equal(orgId, [...api.state.orgs.values()].find((o) => o["slug"] === "maya")!["id"]);

    const anon = await cli(["mcp"], { env: { FABPLANE_CREDENTIALS_FILE: join(dir, "none.json") }, io: { runMcp: async () => {} } });
    assert.equal(anon.code, 0);
    assert.match(anon.stderr, /not logged in/);
  });

  it("desktop status/projects/tools/call", async () => {
    const daemon = await startFakeDaemon();
    try {
      await writeFile(join(dir, "daemon.json"), JSON.stringify({ version: "9.9.9", pid: process.pid, port: daemon.port, host: "127.0.0.1", token: DAEMON_TOKEN, startedAt: "now" }));
      const env = { FABDESK_HOME: dir };
      const status = await cli(["desktop", "status"], { env });
      assert.equal(status.code, 0, status.stderr);
      assert.match(status.stdout, /fabdesk: +9\.9\.9 at http:\/\/127\.0\.0\.1:\d+/);
      assert.match(status.stdout, /auth: +fabplane \/ signed_in as maya/);
      const statusJson = await cli(["desktop", "status", "--json"], { env });
      assert.equal(statusJson.json().handshake.token, "***", "the daemon token is never printed");
      assert.match((await cli(["desktop", "projects"], { env })).stdout, /p1 +Blinky/);
      assert.match((await cli(["desktop", "tools"], { env })).stdout, /board_stats +kicad/);
      const call = await cli(["desktop", "call", "board_stats", '{"verbose":true}', "--project", "p1"], { env });
      assert.equal(call.stdout, "2 layers");
      assert.deepEqual(daemon.requests.at(-1)?.body, { args: { verbose: true }, project: "p1" });
      assert.equal((await cli(["desktop", "call", "route_run"], { env })).stdout, "Queued as job j1");
      assert.equal((await cli(["desktop", "call", "verify_drc"], { env })).code, 1);
      assert.equal((await cli(["desktop", "call", "board_stats", "[1]"], { env })).code, 2);
      const down = await cli(["desktop", "status"], { env: { FABDESK_DAEMON_FILE: join(dir, "missing.json") } });
      assert.equal(down.code, 1);
      assert.match(down.stderr, /fabdesk is not running/);
    } finally {
      await daemon.close();
    }
  });
});

describe("the built bin", () => {
  const root = (() => {
    let d = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(d, "package.json"))) d = dirname(d);
    return d;
  })();
  const bin = join(root, "dist", "cli.js");
  it("runs under plain node", { skip: !existsSync(bin) && "dist/ not built" }, () => {
    const help = spawnSync(process.execPath, [bin, "help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes(`fabplane ${VERSION}`));
    const bad = spawnSync(process.execPath, [bin, "orgs", "list"], { encoding: "utf8", env: { ...process.env, FABPLANE_TOKEN: "", FABPLANE_CREDENTIALS_FILE: join(tmpdir(), "fabplane-none.json"), FABPLANE_API_ORIGIN: "http://127.0.0.1:9" } });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Not logged in/);
  });
});

describe("scripts/sync-spec.ts", () => {
  const root = (() => {
    let d = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(d, "package.json"))) d = dirname(d);
    return d;
  })();
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const canStrip = !process.versions["bun"] && (major > 22 || (major === 22 && minor >= 6));
  it("skips cleanly when the API has no openapi.json yet", { skip: !canStrip && "needs node >= 22.6 type stripping" }, async () => {
    const before = readFileSync(join(root, "spec", "openapi.json"), "utf8");
    // Async: the fake API runs in this process and must keep answering.
    const r = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "scripts", "sync-spec.ts")], {
      encoding: "utf8",
      env: { ...process.env, FABPLANE_API_ORIGIN: api.origin, GITHUB_OUTPUT: join(dir, "out.txt") },
    });
    assert.match(r.stdout, /answered 404 \(not deployed yet\); skipping/);
    assert.equal(readFileSync(join(root, "spec", "openapi.json"), "utf8"), before);
    assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "changed=false\n");
  });
});

describe("inventory photos", () => {
  // A fresh org per run: other suites fill the personal org's inventory.
  let slug = "";
  const pc = (argv: string[]) => cli([...argv, "--org", slug]);
  async function seedItems(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const r = await pc(["inventory", "add", "--name", name, "--mpn", `${name}-MPN`, "--json"]);
      assert.equal(r.code, 0, r.stderr);
      ids.push(r.json().item.id);
    }
    return ids;
  }

  it("queue, claim, attach --url, skip, retry, requeue", async () => {
    await login();
    slug = `photos-${Date.now()}`;
    assert.equal((await cli(["orgs", "create", "Photos", "--slug", slug])).code, 0);
    const [a, b, c] = await seedItems(["Photo A", "Photo B", "Photo C"]);
    const queue = await pc(["inventory", "photos", "queue"]);
    assert.equal(queue.code, 0, queue.stderr);
    assert.match(queue.stdout, /^queued \d+ · available \d+ · leased 0 · skipped \d+/);
    assert.match(queue.stdout, /Photo A/);

    const claim = await pc(["inventory", "photos", "claim", "--limit", "2", "--lease", "600", "--worker", "test-bot", "--json"]);
    assert.equal(claim.code, 0, claim.stderr);
    const claimed = claim.json().items as Array<{ id: string; leaseToken?: string; photoSearch: { attempts: number; leaseOwner: string } }>;
    assert.equal(claimed.length, 2);
    assert.equal(claimed[0]!.photoSearch.leaseOwner, "test-bot");
    assert.equal(claimed[0]!.photoSearch.attempts, 1);
    const claimReq = api.requests.filter((r) => r.path.endsWith("/photo-queue/claim")).at(-1)!;
    assert.deepEqual(claimReq.body, { limit: 2, leaseSeconds: 600, worker: "test-bot" });
    assert.match(claimed[0]!.leaseToken ?? "", /^[0-9a-f-]{36}$/, "claim --json includes the lease token");
    const human = await pc(["inventory", "photos", "claim", "--limit", "1", "--lease", "60"]);
    assert.match(human.stdout, /Pass each lease token to photos skip\/retry/);
    assert.match(human.stdout, /LEASE TOKEN/);
    const humanId = c!;
    const humanToken = api.state.inventory.get(humanId)!["leaseToken"] as string;
    assert.ok(human.stdout.includes(humanToken), "human output prints the token");
    const lost = await pc(["inventory", "photos", "retry", humanId]);
    assert.equal(lost.code, 1);
    assert.match(lost.stderr, /^Error: lease lost: another worker reclaimed this item; leave it alone$/);
    const lostJson = await pc(["inventory", "photos", "skip", humanId, "--lease-token", "wrong", "--json"]);
    assert.equal(JSON.parse(lostJson.stderr).error, "lease_lost");
    const ok = await pc(["inventory", "photos", "retry", humanId, "--lease-token", humanToken]);
    assert.equal(ok.code, 0, ok.stderr);
    const releaseWithToken = api.requests.filter((r) => r.path.endsWith("/photo-queue/release")).at(-1)!;
    assert.deepEqual(releaseWithToken.body, { outcome: "retry", leaseToken: humanToken });
    const all = await pc(["inventory", "photos", "queue", "--all", "--json"]);
    assert.ok(all.json().counts.leased >= 2);
    assert.match((await pc(["inventory", "photos", "queue", "--all"])).stdout, /test-bot until/);
    assert.equal((await pc(["inventory", "photos", "claim", "--limit", "26"])).code, 2);
    assert.equal((await pc(["inventory", "photos", "claim", "--lease", "30"])).code, 2);

    const attach = await pc(["inventory", "photos", "attach", a!, "--url", `${api.origin}/img/redirect`]);
    assert.equal(attach.code, 0, attach.stderr);
    assert.match(attach.stdout, /Attached image\/png \(\d+ bytes\) to .* from http:\/\/127\.0\.0\.1:\d+\/img\/redirect/);
    const itemA = api.state.inventory.get(a!)!;
    assert.equal(itemA["images"][0].source, "web");
    assert.equal(itemA["images"][0].sourceUrl, `${api.origin}/img/redirect`);
    assert.equal(itemA["photoSearch"].leaseUntil, null, "upload clears the lease");

    const withPage = await pc(["inventory", "photos", "attach", b!, "--url", `${api.origin}/img/octet`, "--source-url", "https://www.example.com/product/b", "--json"]);
    assert.equal(withPage.code, 0, withPage.stderr);
    assert.equal(withPage.json().image.sourceUrl, "https://www.example.com/product/b");
    assert.equal(withPage.json().image.contentType, "image/jpeg");

    const bad = await pc(["inventory", "photos", "attach", c!, "--url", `${api.origin}/img/page.html`]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Not an accepted image/);
    assert.match((await pc(["inventory", "photos", "attach", c!, "--url", `${api.origin}/img/big-declared`])).stderr, /limit is 10485760 \(10 MiB\)/);
    assert.equal((await pc(["inventory", "photos", "attach", c!])).code, 2);
    assert.equal((await pc(["inventory", "photos", "attach", c!, "--url", "x", "--file", "y"])).code, 2);
    assert.equal((await pc(["inventory", "photos", "attach", c!, "--url", `${api.origin}/img/part.png`, "--source-url", "ftp://x"])).code, 2);

    await writeFile(join(dir, "shot.jpg"), JSON_SAFE_JPEG);
    const fromFile = await pc(["inventory", "photos", "attach", c!, "--file", "shot.jpg", "--json"]);
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.equal(fromFile.json().image.source, "user");
    await writeFile(join(dir, "fake.png"), "not really");
    assert.match((await pc(["inventory", "photos", "attach", c!, "--file", "fake.png"])).stderr, /Not an accepted image|unrecognised/);

    const [d, e] = await seedItems(["Photo D", "Photo E"]);
    const skip = await pc(["inventory", "photos", "skip", d!, "--note", "obsolete part, no images online"]);
    assert.match(skip.stdout, /Skipped Photo D .*left the photo queue/);
    assert.equal(api.state.inventory.get(d!)!["photoSearch"].status, "skipped");
    assert.equal(api.state.inventory.get(d!)!["photoSearch"].note, "obsolete part, no images online");
    const retry = await pc(["inventory", "photos", "retry", e!]);
    assert.match(retry.stdout, /Released Photo E .* back to the queue \(attempts: \d+\)/);
    const releaseReq = api.requests.filter((r) => r.path.endsWith("/photo-queue/release")).at(-1)!;
    assert.deepEqual(releaseReq.body, { outcome: "retry" });
    const withSkipped = await pc(["inventory", "photos", "queue", "--all", "--json"]);
    assert.ok(withSkipped.json().items.some((i: { id: string; photoSearch: { status: string } }) => i.id === d && i.photoSearch.status === "skipped"), "--all lists skipped items");
    assert.ok(!(await pc(["inventory", "photos", "queue", "--json"])).json().items.some((i: { id: string }) => i.id === d));
    assert.equal((await pc(["inventory", "photos", "attach", e!, "--file", "shot.jpg", "--source", "x".repeat(81)])).code, 2);
    const requeue = await pc(["inventory", "photos", "requeue", d!]);
    assert.match(requeue.stdout, /Requeued Photo D/);
    assert.equal(api.state.inventory.get(d!)!["photoSearch"].status, "queued");
    assert.equal(api.state.inventory.get(d!)!["photoSearch"].attempts, 0);

    const empty = await pc(["inventory", "photos", "claim", "--limit", "25"]);
    assert.equal(empty.code, 0);
    const again = await pc(["inventory", "photos", "claim"]);
    assert.match(again.stdout, /Nothing to claim/);

    const help = await cli(["inventory", "photos"]);
    assert.equal(help.code, 2);
    assert.match(help.stderr, /inventory photos attach <itemId>/);
    assert.doesNotMatch(help.stderr, /inventory adjust/);
    assert.match((await cli(["help"])).stdout, /  inventory photos claim/);
  });
});

const JSON_SAFE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
