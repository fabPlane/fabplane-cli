/**
 * A small in-memory implementation of the fabplane v1 contract on a real loopback HTTP server,
 * shared by the CLI and MCP tests. It is deliberately forgiving: enough behaviour to exercise the
 * client end to end (auth, org scoping, 204s, multipart, redirects, 501), not a reference server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

type Json = Record<string, any>;

export const BUILTINS = [
  ["jlcpcb", "JLCPCB", "fab", "https://jlcpcb.com"],
  ["pcbway", "PCBWay", "fab", "https://www.pcbway.com"],
  ["digikey", "DigiKey", "distributor", "https://www.digikey.com"],
  ["lcsc", "LCSC", "distributor", "https://www.lcsc.com"],
  ["manual", "Manual purchase", "manual", null],
].map(([key, name, kind, url]) => ({ id: `builtin:${key}`, name, kind, url, builtin: true, baseId: null }));

export interface FakeApi {
  origin: string;
  close(): Promise<void>;
  state: FakeState;
  requests: Array<{ method: string; path: string; query: string; auth: string | null; contentType: string | null; body: unknown }>;
}

export type FakeState = {
  tokens: Map<string, { userId: string; api?: Json }>;
  users: Map<string, Json>;
  orgs: Map<string, Json>;
  memberships: Array<{ orgId: string; userId: string; role: string; joinedAt: string }>;
  invites: Map<string, Json>;
  destinations: Map<string, Json>;
  carts: Map<string, Json>;
  inventory: Map<string, Json>;
  deviceCodes: Map<string, { userCode: string; approved: boolean; polls: number }>;
  botConnects: Map<string, Json>;
  bots: Map<string, Json>;
  settings: Json | null;
};

const now = () => new Date().toISOString();

export const USER_TOKEN = "fpd_test_user_token_0123456789";
export const OTHER_TOKEN = "fpk_other_user_token_0123456789";

export function seedState(): FakeState {
  const state: FakeState = {
    tokens: new Map(),
    users: new Map(),
    orgs: new Map(),
    memberships: [],
    invites: new Map(),
    destinations: new Map(),
    carts: new Map(),
    inventory: new Map(),
    deviceCodes: new Map(),
    botConnects: new Map(),
    bots: new Map(),
    settings: null,
  };
  const maya = { id: randomUUID(), subject: "password:maya@example.com", handle: "maya", displayName: "Maya Chen", email: "maya@example.com", emailVerified: true };
  const bob = { id: randomUUID(), subject: "github:bob", handle: "bob", displayName: "Bob", email: "bob@example.com", emailVerified: true };
  state.users.set(maya.id, maya);
  state.users.set(bob.id, bob);
  state.tokens.set(USER_TOKEN, { userId: maya.id });
  state.tokens.set(OTHER_TOKEN, { userId: bob.id });
  for (const u of [maya, bob]) {
    const org = { id: randomUUID(), slug: u.handle, name: `${u.displayName}'s workspace`, personal: true, domainJoin: null, createdAt: now() };
    state.orgs.set(org.id, org);
    state.memberships.push({ orgId: org.id, userId: u.id, role: "owner", joinedAt: now() });
    (u as Json)["personalOrgId"] = org.id;
  }
  const team = { id: randomUUID(), slug: "acme", name: "Acme Hardware", personal: false, domainJoin: { domain: "example.com", enabled: true }, createdAt: now() };
  state.orgs.set(team.id, team);
  state.memberships.push({ orgId: team.id, userId: bob.id, role: "owner", joinedAt: now() });
  return state;
}

/** Creates a bot user in `orgId` with one fpb_ token; returns [bot view, token]. */
export function makeBot(state: FakeState, orgId: string, input: { name: string; role?: string; agentKind?: string | null; createdBy?: string | null }): [Json, string] {
  const id = randomUUID();
  const user = { id, subject: `bot:${id}`, handle: input.name, displayName: input.name, email: null, kind: "bot", botOrgId: orgId };
  state.users.set(id, user);
  state.memberships.push({ orgId, userId: id, role: input.role ?? "member", joinedAt: now() });
  const bot = { id, orgId, name: input.name, agentKind: input.agentKind ?? null, role: input.role ?? "member", createdBy: input.createdBy ?? null, createdAt: now(), lastUsedAt: null };
  state.bots.set(id, bot);
  const token = `fpb_${randomUUID().replace(/-/g, "")}`;
  state.tokens.set(token, { userId: id });
  return [bot, token];
}

export function freshPhotoSearch(): Json {
  return { status: "queued", attempts: 0, note: null, leaseUntil: null, leaseOwner: null };
}

/** 1x1 PNG. */
export const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

/** Test images for the photo-attach download path. */
function serveImage(name: string, res: ServerResponse): void {
  switch (name) {
    case "part.png":
      res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_BYTES.length) });
      res.end(PNG_BYTES);
      return;
    case "redirect":
      res.writeHead(302, { location: "/img/part.png" });
      res.end();
      return;
    case "octet":
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(JPEG_BYTES);
      return;
    case "page.html":
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not an image</html>");
      return;
    case "big-declared":
      res.writeHead(200, { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) });
      res.end();
      return;
    case "big-streamed": {
      res.writeHead(200, { "content-type": "image/png" });
      const chunk = Buffer.alloc(1024 * 1024);
      PNG_BYTES.copy(chunk);
      let sent = 0;
      const pump = () => {
        while (sent < 11) {
          sent++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => undefined);
      pump();
      return;
    }
    case "slow":
      res.writeHead(200, { "content-type": "image/png" });
      res.write(PNG_BYTES.subarray(0, 8));
      setTimeout(() => res.end(), 3000).unref();
      return;
    case "missing":
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (typeof body === "string") {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const err = (res: ServerResponse, status: number, error: string, message?: string) => send(res, status, { error, ...(message ? { message } : {}) });

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeApi(state: FakeState = seedState()): Promise<FakeApi> {
  const requests: FakeApi["requests"] = [];
  let origin = "";
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      send(res, 500, { error: "internal", message: String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin);
    const method = req.method ?? "GET";
    const raw = await readBody(req);
    const contentType = req.headers["content-type"] ?? null;
    let body: any = undefined;
    let form: FormData | null = null;
    if (raw.length && contentType?.includes("application/json")) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return err(res, 400, "invalid_json");
      }
    } else if (raw.length && contentType?.includes("multipart/form-data")) {
      form = await new Request(url, { method: "POST", headers: { "content-type": contentType }, body: raw }).formData();
      body = { multipart: [...form.keys()] };
    } else if (raw.length) body = raw.toString("utf8");
    requests.push({ method, path: url.pathname, query: url.search, auth: req.headers.authorization ?? null, contentType, body });
    const p = url.pathname;

    /* ---- public ---- */
    if (p === "/v1/public/openapi.json") return err(res, 404, "not_found");
    if (p === "/v1/config") return send(res, 200, { relayUrl: "wss://relay.example.test" });
    if (p.startsWith("/img/")) return serveImage(p.slice(5), res);
    if (p === "/v1/public/catalog") return send(res, 200, { projects: [{ id: "x/y", q: url.searchParams.get("q") }] });

    /* ---- device flow ---- */
    if (p === "/v1/auth/device/code" && method === "POST") {
      if (body?.client_id !== "fabplane-cli") return err(res, 400, "invalid_client");
      const deviceCode = randomUUID();
      const userCode = "ABCD-EFGH";
      state.deviceCodes.set(deviceCode, { userCode, approved: false, polls: 0 });
      return send(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?code=${userCode}`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (p === "/v1/auth/device/token" && method === "POST") {
      const dc = state.deviceCodes.get(body?.device_code);
      if (!dc) return send(res, 400, { error: "invalid_grant" });
      dc.polls++;
      // Auto-approve on the second poll unless approved already.
      if (!dc.approved && dc.polls < 2) return send(res, 400, { error: "authorization_pending" });
      state.deviceCodes.delete(body.device_code);
      return send(res, 200, { access_token: USER_TOKEN, token_type: "Bearer", expires_in: 3600 });
    }
    if (p === "/v1/auth/bot/connect" && method === "POST") {
      if (typeof body?.name !== "string" || !body.name || body.name.length > 80) return err(res, 400, "invalid_request");
      if (body.clientId !== "fabplane-cli") return err(res, 400, "invalid_request", "unknown clientId");
      const connectCode = randomUUID();
      const userCode = `B${state.botConnects.size.toString().padStart(3, "0")}-WXYZ`;
      state.botConnects.set(connectCode, { connectCode, userCode, name: body.name, agentKind: body.agentKind ?? null, requestedOrgSlug: body.org ?? null, status: "pending", polls: 0, issued: false, expiresAt: new Date(Date.now() + 900_000).toISOString() });
      return send(res, 200, {
        connectCode,
        userCode,
        verificationUri: `http://app.example.test/dashboard/bots/connect`,
        verificationUriComplete: `http://app.example.test/dashboard/bots/connect?code=${userCode}`,
        expiresIn: 900,
        interval: 5,
      });
    }
    if (p === "/v1/auth/bot/token" && method === "POST") {
      const req0 = state.botConnects.get(body?.connectCode);
      if (!req0) return send(res, 400, { error: "expired_token" });
      req0["polls"]++;
      // Scripted outcomes keyed on the bot name, so tests can drive every branch.
      const name = String(req0["name"]);
      if (name.includes("slow") && req0["polls"] === 1) return send(res, 429, { error: "slow_down" });
      if (name.includes("deny") && req0["polls"] >= 2) req0["status"] = "denied";
      if (name.includes("expire") && req0["polls"] >= 2) req0["status"] = "expired";
      if (req0["status"] === "pending" && !name.includes("manual") && !name.includes("deny") && !name.includes("expire") && req0["polls"] >= 2) {
        const slug = req0["requestedOrgSlug"];
        const target = [...state.orgs.values()].find((o) => (slug ? o["slug"] === slug : o["slug"] === "maya"));
        if (!target) return send(res, 400, { error: "access_denied" });
        const [bot, token] = makeBot(state, target["id"], { name, agentKind: req0["agentKind"] });
        Object.assign(req0, { status: "approved", bot, token, orgId: target["id"] });
      }
      if (req0["status"] === "pending") return send(res, 428, { error: "authorization_pending" });
      if (req0["status"] === "denied") return send(res, 400, { error: "access_denied" });
      if (req0["status"] === "expired" || req0["issued"]) return send(res, 400, { error: "expired_token" });
      req0["issued"] = true;
      const o = state.orgs.get(req0["orgId"])!;
      return send(res, 200, { accessToken: req0["token"], tokenType: "bearer", bot: req0["bot"], org: { id: o["id"], slug: o["slug"], name: o["name"], memberCount: state.memberships.filter((m) => m.orgId === o["id"]).length } });
    }
    if (p === "/v1/auth/password" && method === "POST") {
      if (body?.password !== "pw") return send(res, 302, undefined, { location: "/login?auth_error=invalid_credentials" });
      return send(res, 302, undefined, { location: "/", "set-cookie": "fp_session=sess123; Path=/; HttpOnly" });
    }
    if (p === "/v1/auth/device/approve" && method === "POST") {
      if (!String(req.headers.cookie ?? "").includes("fp_session=sess123")) return err(res, 401, "unauthorized");
      for (const dc of state.deviceCodes.values()) if (dc.userCode === body?.user_code) dc.approved = true;
      return send(res, 200, { status: "approved" });
    }

    /* ---- auth ---- */
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const session = state.tokens.get(auth);
    const user = session ? state.users.get(session.userId) : undefined;
    if (p === "/v1/auth/me") {
      if (!user) return err(res, 401, "unauthorized");
      return send(res, 200, { user: { subject: user["subject"], handle: user["handle"], displayName: user["displayName"], email: user["email"] } });
    }
    if (p === "/v1/auth/session" && method === "DELETE") {
      if (session) state.tokens.delete(auth);
      return send(res, 204);
    }
    if (!p.startsWith("/v1/private/")) return err(res, 404, "not_found");
    if (!user) return err(res, 401, "unauthorized");
    const uid = user["id"] as string;
    const seg = p.split("/").slice(3).map(decodeURIComponent); // after /v1/private

    const orgView = (org: Json) => {
      const m = state.memberships.find((x) => x.orgId === org["id"] && x.userId === uid);
      return { ...org, role: m?.role ?? "member", memberCount: state.memberships.filter((x) => x.orgId === org["id"]).length };
    };
    const myOrgs = () => state.memberships.filter((m) => m.userId === uid).map((m) => orgView(state.orgs.get(m.orgId)!));

    const isBot = user["kind"] === "bot";
    if (seg[0] === "me" && seg.length === 1 && isBot) {
      return send(res, 200, { principal: { subject: user["subject"], handle: user["handle"], displayName: user["displayName"], kind: "bot" }, bot: state.bots.get(uid), personalOrgId: null });
    }
    if (isBot && ["tokens", "settings", "invites", "bots"].includes(seg[0] ?? "")) return err(res, 403, "forbidden");
    if (isBot && seg[0] === "orgs" && (seg.length === 1 ? method !== "GET" : seg[1] === "joinable" || seg[2] === "join" || seg[2] === "invites" || seg[2] === "bots")) return err(res, 403, "forbidden");
    /* bot connect approval (humans) */
    if (seg[0] === "bots" && seg[1] === "connect" && seg[2]) {
      const reqB = [...state.botConnects.values()].find((r) => r["userCode"] === seg[2]);
      if (!reqB) return err(res, 404, "not_found");
      if (method === "GET" && seg.length === 3) {
        const orgs = state.memberships.filter((m) => m.userId === uid && (m.role === "owner" || m.role === "admin")).map((m) => state.orgs.get(m.orgId)!).map((o) => ({ id: o["id"], slug: o["slug"], name: o["name"], memberCount: 1 }));
        return send(res, 200, { request: { name: reqB["name"], agentKind: reqB["agentKind"], requestedOrgSlug: reqB["requestedOrgSlug"], expiresAt: reqB["expiresAt"], status: reqB["status"] }, orgs });
      }
      if (method === "POST" && seg[3] === "approve") {
        const m = state.memberships.find((x) => x.orgId === body?.orgId && x.userId === uid);
        if (!m || (m.role !== "owner" && m.role !== "admin")) return err(res, 403, "forbidden");
        const [bot, token] = makeBot(state, body.orgId, { name: reqB["name"], role: body.role ?? "member", agentKind: reqB["agentKind"], createdBy: uid });
        Object.assign(reqB, { status: "approved", bot, token, orgId: body.orgId });
        return send(res, 200, { bot });
      }
      if (method === "POST" && seg[3] === "deny") {
        reqB["status"] = "denied";
        return send(res, 204);
      }
    }
    if (seg[0] === "me" && seg.length === 1) {
      return send(res, 200, { principal: { subject: user["subject"], handle: user["handle"], displayName: user["displayName"] }, email: user["email"], emailVerified: user["emailVerified"], personalOrgId: user["personalOrgId"] });
    }
    if (seg[0] === "settings") {
      if (method === "GET") return state.settings ? send(res, 200, state.settings) : err(res, 404, "not_found");
      if (method === "PUT") {
        state.settings = body;
        return send(res, 200, body);
      }
    }
    if (seg[0] === "push") {
      if (method === "POST" && seg.length === 1) return send(res, 200, { tickets: (body?.messages ?? []).map(() => ({ status: "ok" })), queued: { jobId: "job-1" } });
      if (method === "GET" && seg[1]) return send(res, 200, { status: "completed", outcomes: [] });
    }

    /* tokens */
    if (seg[0] === "tokens") {
      if (method === "GET" && seg.length === 1) {
        const tokens = [...state.tokens.values()].filter((t) => t.userId === uid && t.api).map((t) => t.api);
        return send(res, 200, { tokens });
      }
      if (method === "POST" && seg.length === 1) {
        if (typeof body?.name !== "string" || !body.name) return err(res, 400, "invalid_request", "name is required");
        const secret = `fpk_${randomUUID().replace(/-/g, "")}`;
        const api = { id: randomUUID(), name: body.name, prefix: secret.slice(0, 12), createdAt: now(), lastUsedAt: null, expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000).toISOString() : null };
        state.tokens.set(secret, { userId: uid, api });
        return send(res, 201, { token: api, secret });
      }
      if (method === "DELETE" && seg[1]) {
        for (const [k, t] of state.tokens) if (t.api?.["id"] === seg[1] && t.userId === uid) {
          state.tokens.delete(k);
          return send(res, 204);
        }
        return err(res, 404, "not_found");
      }
    }

    /* invites by token */
    if (seg[0] === "invites" && seg[1]) {
      const inv = [...state.invites.values()].find((i) => i["token"] === seg[1]);
      if (!inv) return err(res, 404, "not_found");
      const org = state.orgs.get(inv["orgId"])!;
      if (method === "GET" && seg.length === 2) return send(res, 200, { invite: { orgId: org["id"], orgName: org["name"], role: inv["role"], email: inv["email"], expiresAt: inv["expiresAt"] } });
      if (method === "POST" && seg[2] === "accept") {
        if (inv["email"] && inv["email"] !== user["email"]) return err(res, 403, "forbidden");
        state.invites.delete(inv["id"]);
        if (!state.memberships.some((m) => m.orgId === org["id"] && m.userId === uid)) state.memberships.push({ orgId: org["id"], userId: uid, role: inv["role"], joinedAt: now() });
        return send(res, 200, { org: orgView(org) });
      }
    }

    if (seg[0] !== "orgs") return err(res, 404, "not_found");
    if (seg.length === 1) {
      if (method === "GET") return send(res, 200, { orgs: myOrgs() });
      if (method === "POST") {
        if (typeof body?.name !== "string" || !body.name) return err(res, 400, "invalid_request");
        const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        if ([...state.orgs.values()].some((o) => o["slug"] === slug)) return err(res, 409, "conflict", "slug taken");
        const org = { id: randomUUID(), slug, name: body.name, personal: false, domainJoin: null, createdAt: now() };
        state.orgs.set(org.id, org);
        state.memberships.push({ orgId: org.id, userId: uid, role: "owner", joinedAt: now() });
        return send(res, 201, { org: orgView(org) });
      }
    }
    if (seg[1] === "joinable" && seg.length === 2) {
      const domain = String(user["email"]).split("@")[1];
      const orgs = [...state.orgs.values()]
        .filter((o) => o["domainJoin"]?.enabled && o["domainJoin"].domain === domain && !state.memberships.some((m) => m.orgId === o["id"] && m.userId === uid))
        .map((o) => ({ id: o["id"], slug: o["slug"], name: o["name"], memberCount: state.memberships.filter((m) => m.orgId === o["id"]).length }));
      return send(res, 200, { orgs });
    }
    const orgId = seg[1]!;
    const org = state.orgs.get(orgId);
    if (!org) return err(res, 404, "not_found");
    if (seg[2] === "join" && method === "POST") {
      const domain = String(user["email"]).split("@")[1];
      if (!org["domainJoin"]?.enabled || org["domainJoin"].domain !== domain) return err(res, 403, "forbidden");
      state.memberships.push({ orgId, userId: uid, role: "member", joinedAt: now() });
      return send(res, 200, { org: orgView(org) });
    }
    const membership = state.memberships.find((m) => m.orgId === orgId && m.userId === uid);
    if (!membership) return err(res, 404, "not_found");
    const isAdmin = membership.role === "owner" || membership.role === "admin";

    /* bots (admin) */
    if (seg[2] === "bots") {
      if (!isAdmin) return err(res, 403, "forbidden");
      if (seg.length === 3 && method === "GET") return send(res, 200, { bots: [...state.bots.values()].filter((b) => b["orgId"] === orgId) });
      if (seg.length === 3 && method === "POST") {
        if (typeof body?.name !== "string" || !body.name) return err(res, 400, "invalid_request");
        const [bot, token] = makeBot(state, orgId, { name: body.name, role: body.role ?? "member", agentKind: body.agentKind ?? null, createdBy: uid });
        return send(res, 201, { bot, token });
      }
      const bot = state.bots.get(seg[3] ?? "");
      if (!bot || bot["orgId"] !== orgId) return err(res, 404, "not_found");
      if (seg[4] === "tokens" && method === "POST") {
        for (const [k, t] of state.tokens) if (t.userId === bot["id"]) state.tokens.delete(k);
        const token = `fpb_${randomUUID().replace(/-/g, "")}`;
        state.tokens.set(token, { userId: bot["id"] });
        return send(res, 201, { token });
      }
      if (seg.length === 4 && method === "DELETE") {
        for (const [k, t] of state.tokens) if (t.userId === bot["id"]) state.tokens.delete(k);
        state.bots.delete(bot["id"]);
        state.memberships = state.memberships.filter((m) => m.userId !== bot["id"]);
        return send(res, 204);
      }
    }

    if (seg.length === 2) {
      if (method === "GET") return send(res, 200, { org: orgView(org) });
      if (method === "PATCH") {
        if (!isAdmin) return err(res, 403, "forbidden");
        if (body.name) org["name"] = body.name;
        if (body.domainJoin !== undefined) org["domainJoin"] = body.domainJoin;
        return send(res, 200, { org: orgView(org) });
      }
      if (method === "DELETE") {
        if (membership.role !== "owner" || org["personal"]) return err(res, 403, "forbidden");
        state.orgs.delete(orgId);
        return send(res, 204);
      }
    }

    /* members */
    if (seg[2] === "members") {
      if (seg.length === 3 && method === "GET") {
        const members = state.memberships
          .filter((m) => m.orgId === orgId)
          .map((m) => {
            const u = state.users.get(m.userId)!;
            return { userId: u["id"], handle: u["handle"], displayName: u["displayName"], email: u["email"], role: m.role, joinedAt: m.joinedAt, kind: u["kind"] === "bot" ? "bot" : "human" };
          });
        return send(res, 200, { members });
      }
      const target = state.memberships.find((m) => m.orgId === orgId && m.userId === seg[3]);
      if (!target) return err(res, 404, "not_found");
      if (method === "PATCH") {
        if (!isAdmin) return err(res, 403, "forbidden");
        target.role = body.role;
        const u = state.users.get(target.userId)!;
        return send(res, 200, { member: { userId: u["id"], handle: u["handle"], displayName: u["displayName"], email: u["email"], role: target.role, joinedAt: target.joinedAt } });
      }
      if (method === "DELETE") {
        if (!isAdmin && target.userId !== uid) return err(res, 403, "forbidden");
        state.memberships.splice(state.memberships.indexOf(target), 1);
        return send(res, 204);
      }
    }

    /* invites */
    if (seg[2] === "invites") {
      if (!isAdmin) return err(res, 403, "forbidden");
      if (seg.length === 3 && method === "GET") return send(res, 200, { invites: [...state.invites.values()].filter((i) => i["orgId"] === orgId).map(({ orgId: _o, ...i }) => i) });
      if (seg.length === 3 && method === "POST") {
        const token = randomUUID().replace(/-/g, "");
        const inv = { id: randomUUID(), orgId, email: body?.email ?? null, role: body?.role ?? "member", token, url: `http://app.example.test/dashboard/invite/${token}`, createdAt: now(), expiresAt: new Date(Date.now() + (body?.expiresInDays ?? 14) * 86400000).toISOString(), createdBy: uid };
        state.invites.set(inv.id, inv);
        const { orgId: _o, ...view } = inv;
        return send(res, 201, { invite: view });
      }
      if (method === "DELETE" && seg[3]) return state.invites.delete(seg[3]) ? send(res, 204) : err(res, 404, "not_found");
    }

    /* destinations */
    if (seg[2] === "destinations") {
      if (seg.length === 3 && method === "GET") return send(res, 200, { destinations: [...BUILTINS, ...[...state.destinations.values()].filter((d) => d["orgId"] === orgId).map(({ orgId: _o, ...d }) => d)] });
      if (!isAdmin) return err(res, 403, "forbidden");
      if (seg.length === 3 && method === "POST") {
        if (!body?.name || !/^https?:\/\//.test(body?.url ?? "")) return err(res, 400, "invalid_request");
        const d = { id: randomUUID(), orgId, name: body.name, kind: body.kind ?? "distributor", url: body.url, builtin: false, baseId: body.baseId ?? null };
        state.destinations.set(d.id, d);
        const { orgId: _o, ...view } = d;
        return send(res, 201, { destination: view });
      }
      if (method === "DELETE" && seg[3]) return state.destinations.delete(seg[3]) ? send(res, 204) : err(res, 404, "not_found");
    }

    /* carts */
    if (seg[2] === "carts") {
      const summary = (c: Json) => ({ id: c["id"], orgId: c["orgId"], name: c["name"], repos: c["repos"], projectId: c["projectId"], fabDestinationId: c["fabDestinationId"], itemCount: c["items"].length, updatedAt: c["updatedAt"], createdAt: c["createdAt"] });
      const full = (c: Json) => {
        const by = new Map<string, { destinationId: string; itemCount: number; totalQuantity: number }>();
        for (const i of c["items"]) {
          const e = by.get(i.destinationId) ?? { destinationId: i.destinationId, itemCount: 0, totalQuantity: 0 };
          e.itemCount++;
          e.totalQuantity += i.quantity;
          by.set(i.destinationId, e);
        }
        return { ...summary(c), notes: c["notes"], items: c["items"], byDestination: [...by.values()] };
      };
      const toItem = (c: Json, input: Json) => ({ kind: "part", status: "needed", ...input, destinationId: input["destinationId"] ?? c["fabDestinationId"], id: randomUUID(), createdAt: now(), updatedAt: now() });
      if (seg.length === 3 && method === "GET") {
        const repo = url.searchParams.get("repo");
        const project = url.searchParams.get("projectId");
        const carts = [...state.carts.values()].filter((c) => c["orgId"] === orgId && (!repo || c["repos"].includes(repo)) && (!project || c["projectId"] === project));
        return send(res, 200, { carts: carts.map(summary) });
      }
      if (seg.length === 3 && method === "POST") {
        if (!body?.name) return err(res, 400, "invalid_request");
        const c = { id: randomUUID(), orgId, name: body.name, repos: body.repos ?? [], projectId: body.projectId ?? null, notes: body.notes ?? null, fabDestinationId: body.fabDestinationId ?? "builtin:jlcpcb", items: [] as Json[], createdAt: now(), updatedAt: now() };
        state.carts.set(c.id, c);
        return send(res, 201, { cart: full(c) });
      }
      const cart = state.carts.get(seg[3] ?? "");
      if (!cart || cart["orgId"] !== orgId) return err(res, 404, "not_found");
      if (seg.length === 4) {
        if (method === "GET") return send(res, 200, { cart: full(cart) });
        if (method === "PATCH") {
          Object.assign(cart, body);
          return send(res, 200, { cart: full(cart) });
        }
        if (method === "DELETE") {
          state.carts.delete(cart["id"]);
          return send(res, 204);
        }
      }
      if (seg[4] === "export.csv" && method === "GET") {
        const dest = url.searchParams.get("destinationId");
        const rows = cart["items"].filter((i: Json) => !dest || i["destinationId"] === dest).map((i: Json) => [i["destinationId"], i["kind"], i["mpn"] ?? "", i["manufacturer"] ?? "", i["description"] ?? "", (i["refs"] ?? []).join(" "), i["quantity"], i["sku"] ?? "", i["url"] ?? "", i["unitPrice"] ?? "", i["currency"] ?? "", i["status"], i["notes"] ?? ""].join(","));
        res.writeHead(200, { "content-type": "text/csv" });
        res.end(["destination,kind,mpn,manufacturer,description,refs,quantity,sku,url,unitPrice,currency,status,notes", ...rows].join("\n") + "\n");
        return;
      }
      if (seg[4] === "items") {
        if (seg.length === 5 && method === "POST") {
          const items = body?.items;
          if (!Array.isArray(items) || items.length < 1 || items.length > 500) return err(res, 400, "invalid_request", "items must have 1..500 entries");
          if (items.some((i: Json) => !Number.isInteger(i["quantity"]))) return err(res, 400, "invalid_request", "quantity must be an integer");
          const created = items.map((i: Json) => toItem(cart, i));
          cart["items"].push(...created);
          return send(res, 201, { items: created });
        }
        if (seg.length === 5 && method === "PUT") {
          cart["items"] = (body?.items ?? []).map((i: Json) => toItem(cart, i));
          return send(res, 200, { cart: full(cart) });
        }
        const idx = cart["items"].findIndex((i: Json) => i["id"] === seg[5]);
        if (idx < 0) return err(res, 404, "not_found");
        if (method === "PATCH") {
          Object.assign(cart["items"][idx], body, { updatedAt: now() });
          return send(res, 200, { item: cart["items"][idx] });
        }
        if (method === "DELETE") {
          cart["items"].splice(idx, 1);
          return send(res, 204);
        }
      }
    }

    /* inventory */
    if (seg[2] === "inventory") {
      const view = (i: Json) => {
        const { serverAiProcessing: _s, leaseToken: _l, ...rest } = i;
        return rest;
      };
      const upsert = (input: Json): { item: Json; created: boolean } => {
        if (input["serverAiProcessing"]) throw Object.assign(new Error("ai"), { ai: true });
        const existing = input["externalId"]
          ? [...state.inventory.values()].find((i) => i["orgId"] === orgId && i["source"] === input["source"] && i["externalId"] === input["externalId"])
          : undefined;
        if (existing) {
          Object.assign(existing, input, { updatedAt: now() });
          return { item: existing, created: false };
        }
        const item = { quantity: 0, unit: "pcs", tags: [], attributes: {}, ...input, id: randomUUID(), orgId, images: [] as Json[], photoSearch: freshPhotoSearch(), createdBy: uid, createdAt: now(), updatedAt: now() };
        state.inventory.set(item.id, item);
        return { item, created: true };
      };
      const AI_MESSAGE = "Server-side AI processing is not available yet; extract fields locally and send them";
      if (seg.length === 3 && method === "GET") {
        const q = url.searchParams.get("q")?.toLowerCase();
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        const all = [...state.inventory.values()].filter((i) => i["orgId"] === orgId && (!q || [i["name"], i["mpn"], i["manufacturer"], i["description"], i["sku"]].some((f) => String(f ?? "").toLowerCase().includes(q))));
        const page = all.slice(cursor, cursor + limit);
        return send(res, 200, { items: page.map(view), nextCursor: cursor + limit < all.length ? String(cursor + limit) : null });
      }
      if (seg.length === 3 && method === "POST") {
        let input: Json;
        let files: Array<{ type: string; size: number; name: string }> = [];
        if (form) {
          input = JSON.parse(String(form.get("item")));
          files = form.getAll("image").filter((f) => typeof f !== "string") as unknown as typeof files;
        } else input = body;
        if (!input?.["name"]) return err(res, 400, "invalid_request");
        try {
          const { item, created } = upsert(input);
          for (const f of files) item["images"].push({ id: randomUUID(), contentType: f.type, bytes: f.size, url: `${origin}/signed/${f.name}`, createdAt: now() });
          return send(res, created ? 201 : 200, { item: view(item) });
        } catch (e) {
          if ((e as { ai?: boolean }).ai) return err(res, 501, "server_ai_unavailable", AI_MESSAGE);
          throw e;
        }
      }
      const inQueue = (i: Json) => i["orgId"] === orgId && i["images"].length === 0 && i["photoSearch"].status === "queued";
      const leased = (i: Json) => i["photoSearch"].leaseUntil !== null && Date.parse(i["photoSearch"].leaseUntil) > Date.now();
      const queueView = (i: Json) => {
        const out: Json = { id: i["id"], name: i["name"], attributes: i["attributes"], tags: i["tags"], photoSearch: { ...i["photoSearch"] } };
        for (const k of ["mpn", "manufacturer", "sku", "category", "description"]) if (i[k] !== undefined) out[k] = i[k];
        return out;
      };
      if (seg[3] === "photo-queue" && seg.length === 4 && method === "GET") {
        const all = [...state.inventory.values()].filter((i) => i["orgId"] === orgId);
        const queued = all.filter(inQueue);
        const counts = { queued: queued.length, available: queued.filter((i) => !leased(i)).length, leased: queued.filter(leased).length, skipped: all.filter((i) => i["photoSearch"].status === "skipped").length };
        // include=all: every imageless item, leased and skipped included (so skipped ones can be requeued).
        const list = url.searchParams.get("include") === "all" ? all.filter((i) => i["images"].length === 0) : queued.filter((i) => !leased(i));
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        return send(res, 200, { items: list.slice(cursor, cursor + limit).map(queueView), nextCursor: cursor + limit < list.length ? String(cursor + limit) : null, counts });
      }
      if (seg[3] === "photo-queue" && seg[4] === "claim" && method === "POST") {
        const limit = body?.limit ?? 5;
        const leaseSeconds = body?.leaseSeconds ?? 900;
        if (limit < 1 || limit > 25 || leaseSeconds < 60 || leaseSeconds > 3600) return err(res, 400, "invalid_request");
        const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
        const picked = [...state.inventory.values()]
          .filter((i) => inQueue(i) && !leased(i))
          .sort((a, b) => a["photoSearch"].attempts - b["photoSearch"].attempts || a["createdAt"].localeCompare(b["createdAt"]))
          .slice(0, limit);
        for (const i of picked) {
          Object.assign(i["photoSearch"], { leaseUntil, leaseOwner: body?.worker ?? null, attempts: i["photoSearch"].attempts + 1 });
          i["leaseToken"] = randomUUID();
        }
        return send(res, 200, { items: picked.map((i) => ({ ...queueView(i), leaseToken: i["leaseToken"] })), leaseUntil });
      }
      if (seg[3] === "bulk" && method === "POST") {
        const items = body?.items;
        if (!Array.isArray(items) || items.length < 1 || items.length > 500) return err(res, 400, "invalid_request", "items must have 1..500 entries");
        let created = 0;
        let updated = 0;
        const out: Json[] = [];
        try {
          for (const i of items) {
            const r = upsert(i);
            r.created ? created++ : updated++;
            out.push(view(r.item));
          }
        } catch (e) {
          if ((e as { ai?: boolean }).ai) return err(res, 501, "server_ai_unavailable", AI_MESSAGE);
          throw e;
        }
        return send(res, 200, { items: out, created, updated });
      }
      const item = state.inventory.get(seg[3] ?? "");
      if (!item || item["orgId"] !== orgId) return err(res, 404, "not_found");
      if (seg.length === 4) {
        if (method === "GET") return send(res, 200, { item: view(item) });
        if (method === "PATCH") {
          Object.assign(item, body, { updatedAt: now() });
          return send(res, 200, { item: view(item) });
        }
        if (method === "DELETE") {
          state.inventory.delete(item["id"]);
          return send(res, 204);
        }
      }
      if (seg[4] === "adjust" && method === "POST") {
        if (!Number.isInteger(body?.delta) || body.delta === 0) return err(res, 400, "invalid_request");
        if (item["quantity"] + body.delta < 0) return err(res, 409, "conflict", "quantity would go below zero");
        item["quantity"] += body.delta;
        return send(res, 200, { item: view(item) });
      }
      if (seg[4] === "photo-queue" && method === "POST") {
        if (seg[5] === "release") {
          if (body?.outcome !== "retry" && body?.outcome !== "not_found") return err(res, 400, "invalid_request");
          if (leased(item) && body.leaseToken !== item["leaseToken"]) return err(res, 409, "conflict", "the item is leased by another worker");
          delete item["leaseToken"];
          Object.assign(item["photoSearch"], { leaseUntil: null, leaseOwner: null, ...(body.note !== undefined ? { note: body.note } : {}) });
          if (body.outcome === "not_found") item["photoSearch"].status = "skipped";
          return send(res, 200, { item: queueView(item) });
        }
        if (seg[5] === "requeue") {
          if (!isAdmin) return err(res, 403, "forbidden");
          item["photoSearch"] = freshPhotoSearch();
          return send(res, 200, { item: queueView(item) });
        }
      }
      if (seg[4] === "images") {
        if (seg.length === 5 && method === "POST") {
          const f = form?.get("image");
          if (!f || typeof f === "string") return err(res, 415, "unsupported_media_type");
          const source = form?.get("source");
          const sourceUrl = form?.get("sourceUrl");
          if (typeof sourceUrl === "string" && (!/^https?:\/\//.test(sourceUrl) || sourceUrl.length > 2000)) return err(res, 400, "invalid_request", "sourceUrl must be an http(s) URL");
          if (item["images"].length >= 10) return err(res, 409, "conflict", "too many images");
          const image = { id: randomUUID(), contentType: f.type, bytes: f.size, url: `${origin}/signed/${f.name}`, createdAt: now(), ...(typeof source === "string" ? { source } : {}), ...(typeof sourceUrl === "string" ? { sourceUrl } : {}) };
          Object.assign(item["photoSearch"], { leaseUntil: null, leaseOwner: null });
          delete item["leaseToken"];
          item["images"].push(image);
          return send(res, 201, { image });
        }
        const img = item["images"].find((i: Json) => i["id"] === seg[5]);
        if (!img) return err(res, 404, "not_found");
        if (method === "GET") return send(res, 302, undefined, { location: `https://storage.example.test/${img["id"]}?sig=abc` });
        if (method === "DELETE") {
          item["images"].splice(item["images"].indexOf(img), 1);
          if (item["images"].length === 0) item["photoSearch"].status = "queued";
          return send(res, 204);
        }
      }
    }
    return err(res, 404, "not_found");
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    state,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
