/**
 * The `fabplane` command line. `runCli(argv, io)` is the whole program minus process wiring,
 * so tests drive it in-process against a fake API.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FabplaneClient, type FetchLike } from "../client.js";
import {
  CredentialStore,
  findOrg,
  resolveAuth,
  resolveDefaultOrg,
  tokenKindOf,
  type Env,
  type ResolvedAuth,
} from "../credentials.js";
import { cartItemsFromCsv, cartItemsFromJson, parseJsonl } from "../csv.js";
import { FabplaneApiError } from "../errors.js";
import { FabdeskClient, FabdeskError } from "../fabdesk.js";
import { runMcpStdio, type FabplaneMcpOptions } from "../mcp.js";
import { dashboardUrlFor } from "../origin.js";
import type { AttributeValue, CartItemInput, ImageUpload, InventoryItemInput, Role } from "../types.js";
import { VERSION } from "../version.js";
import { keyValues, table } from "./format.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Env;
  cwd?: string;
  fetch?: FetchLike;
  /** Opens a URL in the browser; absent = never open. */
  openUrl?(url: string): void;
  readStdin?(): Promise<string>;
  sleep?(ms: number): Promise<void>;
  /** Replaces the stdio MCP server (tests). */
  runMcp?(opts: FabplaneMcpOptions): Promise<void>;
  /** Replaces the fabdesk client (tests). */
  fabdesk?: FabdeskClient;
  isTTY?: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type OptSpec = { type: "string" | "boolean"; multiple?: boolean; short?: string };
type Values = Record<string, string | boolean | string[] | undefined>;

interface Command {
  usage: string;
  summary: string;
  options?: Record<string, OptSpec>;
  run(ctx: Ctx, args: string[], values: Values): Promise<void>;
}

const GLOBAL_OPTIONS: Record<string, OptSpec> = {
  json: { type: "boolean" },
  org: { type: "string" },
  origin: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const GROUPS = new Set(["orgs", "tokens", "destinations", "carts", "inventory", "desktop"]);

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const IMPORT_CHUNK = 500;

class Ctx {
  readonly io: CliIo;
  readonly json: boolean;
  readonly flags: { org?: string; origin?: string };
  readonly store: CredentialStore;
  private authPromise: Promise<ResolvedAuth> | null = null;

  constructor(io: CliIo, json: boolean, flags: { org?: string; origin?: string }) {
    this.io = io;
    this.json = json;
    this.flags = flags;
    this.store = new CredentialStore({ env: io.env });
  }

  auth(): Promise<ResolvedAuth> {
    this.authPromise ??= resolveAuth({
      env: this.io.env,
      store: this.store,
      ...(this.flags.origin ? { origin: this.flags.origin } : {}),
      ...(this.flags.org ? { org: this.flags.org } : {}),
    });
    return this.authPromise;
  }

  newClient(origin: string, token?: string): FabplaneClient {
    return new FabplaneClient({
      origin,
      ...(token ? { token } : {}),
      ...(this.io.fetch ? { fetch: this.io.fetch } : {}),
      headers: { "user-agent": `fabplane-cli/${VERSION}` },
    });
  }

  /** A client with credentials; throws a helpful error when there are none. */
  async client(): Promise<FabplaneClient> {
    const auth = await this.auth();
    if (!auth.token) throw new UsageError(`Not logged in to ${auth.origin}. Run \`fabplane login\` or set FABPLANE_TOKEN.`);
    return this.newClient(auth.origin, auth.token);
  }

  async orgId(): Promise<string> {
    const auth = await this.auth();
    return resolveDefaultOrg(await this.client(), { explicit: auth.orgId, env: {} });
  }

  fabdesk(): FabdeskClient {
    return this.io.fabdesk ?? new FabdeskClient({ env: this.io.env, ...(this.io.fetch ? { fetch: this.io.fetch } : {}) });
  }

  print(data: unknown, human: () => string): void {
    this.io.stdout(this.json ? JSON.stringify(data, null, 2) : human());
  }

  info(text: string): void {
    this.io.stderr(text);
  }

  path(p: string): string {
    return resolve(this.io.cwd ?? process.cwd(), p);
  }

  async readText(p: string): Promise<string> {
    if (p === "-") {
      if (!this.io.readStdin) throw new UsageError("stdin is not available");
      return this.io.readStdin();
    }
    return readFile(this.path(p), "utf8");
  }
}

/* ---------------- helpers ---------------- */

function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" ? v : undefined;
}
function list(values: Values, key: string): string[] {
  const v = values[key];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}
function need(args: string[], index: number, name: string): string {
  const v = args[index];
  if (v === undefined || v === "") throw new UsageError(`Missing <${name}>`);
  return v;
}
function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer (got "${value}")`);
  return n;
}
function num(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number (got "${value}")`);
  return n;
}
function parseJsonArg(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function attrValue(raw: string): AttributeValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
/** Drops undefined values and empty arrays (optional fields stay absent). */
function def<T extends Record<string, unknown>>(obj: T): Defined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Defined<T>;
}
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ---------------- commands ---------------- */

const commands: Record<string, Command> = {
  login: {
    usage: "fabplane login [--token fpk_…] [--origin URL] [--no-browser]",
    summary: "Sign in (browser device flow, or store a personal API token)",
    options: {
      token: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      "no-browser": { type: "boolean" },
    },
    async run(ctx, _args, v) {
      const auth = await ctx.auth();
      const origin = auth.origin;
      const anon = ctx.newClient(origin);
      let token: string;
      let expiresAt: string | null = null;
      const given = str(v, "token");
      const email = str(v, "email");
      if (given) {
        token = given.trim();
      } else if (email) {
        const password = str(v, "password") ?? ctx.io.env["FABPLANE_PASSWORD"];
        if (!password) throw new UsageError("--email needs --password (or FABPLANE_PASSWORD)");
        const res = await anon.loginWithPassword({ email, password }, { clientLabel: `fabplane-cli on ${hostname()}` });
        token = res.access_token;
        expiresAt = res.expires_in > 0 ? new Date(Date.now() + res.expires_in * 1000).toISOString() : null;
      } else {
        const device = await anon.startDeviceLogin({ clientLabel: `fabplane-cli on ${hostname()}` });
        ctx.info(`To sign in, open ${device.verification_uri_complete}\nand confirm the code: ${device.user_code}`);
        if (!v["no-browser"] && ctx.io.openUrl) {
          try {
            ctx.io.openUrl(device.verification_uri_complete);
          } catch {
            /* the URL is printed */
          }
        }
        ctx.info("Waiting for approval…");
        const res = await anon.waitForDeviceToken(device, ctx.io.sleep ? { sleep: (ms) => ctx.io.sleep!(ms) } : {});
        token = res.access_token;
        expiresAt = res.expires_in > 0 ? new Date(Date.now() + res.expires_in * 1000).toISOString() : null;
      }
      const client = ctx.newClient(origin, token);
      const me = await client.getMe().catch(async (err: unknown) => {
        if (err instanceof FabplaneApiError && err.status === 404) return client.me();
        throw err;
      });
      if (!me.user) throw new UsageError("The token was not accepted (no user). Check it and try again.");
      const kind = tokenKindOf(token);
      await ctx.store.saveProfile(origin, {
        token,
        ...(kind ? { tokenKind: kind } : {}),
        expiresAt,
        user: def({
          subject: me.user.subject,
          handle: me.user.handle,
          displayName: me.user.displayName,
          email: me.user.email ?? undefined,
        }),
      });
      const who = me.user.handle ?? me.user.email ?? me.user.subject;
      ctx.print({ ok: true, origin, user: me.user, credentials: ctx.store.path }, () => `Logged in to ${origin} as ${who}.`);
    },
  },

  logout: {
    usage: "fabplane logout [--origin URL]",
    summary: "Forget stored credentials (and revoke a device session)",
    async run(ctx) {
      const auth = await ctx.auth();
      const profile = auth.profile;
      let revoked = false;
      if (profile?.token && (profile.tokenKind ?? tokenKindOf(profile.token)) !== "api") {
        revoked = await ctx
          .newClient(auth.origin, profile.token)
          .logout()
          .then(() => true)
          .catch(() => false);
      }
      const removed = await ctx.store.removeProfile(auth.origin);
      if (auth.tokenSource === "env") ctx.info("Note: FABPLANE_TOKEN is still set in your environment.");
      ctx.print({ ok: true, origin: auth.origin, removed, revoked }, () =>
        removed ? `Logged out of ${auth.origin}.${profile?.tokenKind === "api" ? " (Personal API tokens stay valid; revoke with `fabplane tokens revoke`.)" : ""}` : `No stored credentials for ${auth.origin}.`,
      );
    },
  },

  whoami: {
    usage: "fabplane whoami",
    summary: "Show the signed-in user, API origin and default org",
    async run(ctx) {
      const auth = await ctx.auth();
      const client = await ctx.client();
      const me = await client.getMe();
      const user = me.user;
      ctx.print({ origin: auth.origin, tokenSource: auth.tokenSource, defaultOrgId: auth.orgId ?? user?.personalOrgId ?? null, user }, () =>
        keyValues([
          ["user", user ? (user.handle ?? user.subject) : "(none)"],
          ["name", user?.displayName],
          ["email", user?.email ? `${user.email}${user.emailVerified === false ? " (unverified)" : ""}` : undefined],
          ["origin", auth.origin],
          ["token", auth.tokenSource === "env" ? "FABPLANE_TOKEN" : auth.tokenSource === "file" ? ctx.store.path : auth.tokenSource],
          ["org", auth.orgId ? `${auth.orgId} (${auth.orgSource === "env" ? "FABPLANE_ORG" : auth.orgSource === "flag" ? "--org" : "default"})` : user?.personalOrgId ? `${user.personalOrgId} (personal)` : undefined],
        ]),
      );
    },
  },

  dashboard: {
    usage: "fabplane dashboard [--open]",
    summary: "Print (or open) the web dashboard URL for the current API",
    options: { open: { type: "boolean" } },
    async run(ctx, _args, v) {
      const auth = await ctx.auth();
      const url = dashboardUrlFor(auth.origin);
      if (v["open"] && ctx.io.openUrl) ctx.io.openUrl(url);
      ctx.print({ url }, () => url);
    },
  },

  /* ---------- orgs ---------- */
  "orgs list": {
    usage: "fabplane orgs list",
    summary: "List your orgs (* = default)",
    async run(ctx) {
      const auth = await ctx.auth();
      const { orgs } = await (await ctx.client()).listOrgs();
      const current = auth.orgId ? findOrg(orgs, auth.orgId)?.id : orgs.find((o) => o.personal)?.id;
      ctx.print({ orgs, defaultOrgId: current ?? null }, () =>
        table(
          orgs.map((o) => ({ ...o, mark: o.id === current ? "*" : "" })),
          [["mark", ""], ["slug", "slug"], ["name", "name"], ["role", "role"], ["personal", "personal"], ["memberCount", "members"], ["id", "id"]],
        ),
      );
    },
  },
  "orgs create": {
    usage: "fabplane orgs create <name> [--slug slug]",
    summary: "Create an org (you become owner)",
    options: { slug: { type: "string" } },
    async run(ctx, args, v) {
      const name = need(args, 0, "name");
      const { org } = await (await ctx.client()).createOrg(def({ name, slug: str(v, "slug") }));
      ctx.print({ org }, () => `Created org ${org.name} (${org.slug}) id=${org.id}`);
    },
  },
  "orgs use": {
    usage: "fabplane orgs use <id|slug>",
    summary: "Set the default org for this API origin",
    async run(ctx, args) {
      const wanted = need(args, 0, "id|slug");
      const auth = await ctx.auth();
      const { orgs } = await (await ctx.client()).listOrgs();
      const org = findOrg(orgs, wanted);
      if (!org) throw new UsageError(`No org "${wanted}". Your orgs: ${orgs.map((o) => o.slug).join(", ")}`);
      if (!auth.profile) throw new UsageError("Default orgs are stored with your login; run `fabplane login` first (or set FABPLANE_ORG).");
      await ctx.store.saveProfile(auth.origin, { defaultOrgId: org.id });
      if (ctx.io.env["FABPLANE_ORG"]) ctx.info("Note: FABPLANE_ORG is set and takes precedence.");
      ctx.print({ ok: true, org }, () => `Default org is now ${org.name} (${org.slug}).`);
    },
  },
  "orgs members": {
    usage: "fabplane orgs members [--org id|slug]",
    summary: "List members of the org",
    async run(ctx) {
      const orgId = await ctx.orgId();
      const { members } = await (await ctx.client()).listMembers(orgId);
      ctx.print({ members }, () => table(members, [["handle", "handle"], ["displayName", "name"], ["email", "email"], ["role", "role"], ["joinedAt", "joined"], ["userId", "user id"]]));
    },
  },
  "orgs invites": {
    usage: "fabplane orgs invites [--org id|slug]",
    summary: "List pending invites (admin)",
    async run(ctx) {
      const orgId = await ctx.orgId();
      const { invites } = await (await ctx.client()).listInvites(orgId);
      ctx.print({ invites }, () => table(invites, [["id", "id"], ["email", "email"], ["role", "role"], ["expiresAt", "expires"], ["url", "url"]]));
    },
  },
  "orgs invite": {
    usage: "fabplane orgs invite [--email addr] [--role member|admin] [--days n]",
    summary: "Create an invite link (admin)",
    options: { email: { type: "string" }, role: { type: "string" }, days: { type: "string" } },
    async run(ctx, _args, v) {
      const role = str(v, "role");
      if (role && role !== "member" && role !== "admin") throw new UsageError("--role must be member or admin");
      const orgId = await ctx.orgId();
      const { invite } = await (await ctx.client()).createInvite(
        orgId,
        def({ email: str(v, "email"), role: role as "member" | "admin" | undefined, expiresInDays: int(str(v, "days"), "days") }),
      );
      ctx.print({ invite }, () => `Invite link (${invite.role}${invite.email ? ` for ${invite.email}` : ""}, expires ${invite.expiresAt}):\n${invite.url}`);
    },
  },
  "orgs role": {
    usage: "fabplane orgs role <userId> <owner|admin|member>",
    summary: "Change a member's role (admin)",
    async run(ctx, args) {
      const userId = need(args, 0, "userId");
      const role = need(args, 1, "role");
      if (!["owner", "admin", "member"].includes(role)) throw new UsageError("role must be owner, admin or member");
      const { member } = await (await ctx.client()).updateMember(await ctx.orgId(), userId, { role: role as Role });
      ctx.print({ member }, () => `${member.handle} is now ${member.role}.`);
    },
  },
  "orgs join": {
    usage: "fabplane orgs join <id>",
    summary: "Join an org through its email-domain join",
    async run(ctx, args) {
      const { org } = await (await ctx.client()).joinOrg(need(args, 0, "id"));
      ctx.print({ org }, () => `Joined ${org.name} (${org.slug}) as ${org.role}.`);
    },
  },
  "orgs joinable": {
    usage: "fabplane orgs joinable",
    summary: "Orgs you can join via your verified email domain",
    async run(ctx) {
      const { orgs } = await (await ctx.client()).listJoinableOrgs();
      ctx.print({ orgs }, () => table(orgs, [["slug", "slug"], ["name", "name"], ["memberCount", "members"], ["id", "id"]]));
    },
  },
  "orgs accept": {
    usage: "fabplane orgs accept <invite-token|invite-url>",
    summary: "Accept an invite",
    async run(ctx, args) {
      const raw = need(args, 0, "invite-token");
      const token = raw.includes("/") ? (raw.replace(/\/+$/, "").split("/").pop() ?? raw) : raw;
      const { org } = await (await ctx.client()).acceptInvite(token);
      ctx.print({ org }, () => `Joined ${org.name} (${org.slug}) as ${org.role}.`);
    },
  },

  /* ---------- tokens ---------- */
  "tokens list": {
    usage: "fabplane tokens list",
    summary: "List personal API tokens",
    async run(ctx) {
      const { tokens } = await (await ctx.client()).listTokens();
      ctx.print({ tokens }, () => table(tokens, [["id", "id"], ["name", "name"], ["prefix", "prefix"], ["createdAt", "created"], ["lastUsedAt", "last used"], ["expiresAt", "expires"]]));
    },
  },
  "tokens create": {
    usage: "fabplane tokens create <name> [--days n]",
    summary: "Create a personal API token (shown once)",
    options: { days: { type: "string" } },
    async run(ctx, args, v) {
      const name = need(args, 0, "name");
      const res = await (await ctx.client()).createToken(def({ name, expiresInDays: int(str(v, "days"), "days") }));
      ctx.print(res, () => `${res.secret}\n\nToken "${res.token.name}" (${res.token.id}). Copy it now: it is not shown again.\nUse it with FABPLANE_TOKEN=… or \`fabplane login --token …\`.`);
    },
  },
  "tokens revoke": {
    usage: "fabplane tokens revoke <id>",
    summary: "Revoke a personal API token",
    async run(ctx, args) {
      const id = need(args, 0, "id");
      await (await ctx.client()).deleteToken(id);
      ctx.print({ ok: true, id }, () => `Revoked token ${id}.`);
    },
  },

  /* ---------- destinations ---------- */
  "destinations list": {
    usage: "fabplane destinations list [--org id|slug]",
    summary: "List purchase destinations (built-in + custom)",
    async run(ctx) {
      const { destinations } = await (await ctx.client()).listDestinations(await ctx.orgId());
      ctx.print({ destinations }, () => table(destinations, [["id", "id"], ["name", "name"], ["kind", "kind"], ["url", "url"], ["baseId", "base"]]));
    },
  },
  "destinations add": {
    usage: "fabplane destinations add --name NAME --url URL [--kind fab|distributor|manual] [--base builtin:digikey]",
    summary: "Add a custom destination (admin)",
    options: { name: { type: "string" }, url: { type: "string" }, kind: { type: "string" }, base: { type: "string" } },
    async run(ctx, _args, v) {
      const name = str(v, "name");
      const url = str(v, "url");
      if (!name || !url) throw new UsageError("--name and --url are required");
      const kind = str(v, "kind");
      if (kind && !["fab", "distributor", "manual"].includes(kind)) throw new UsageError("--kind must be fab, distributor or manual");
      const { destination } = await (await ctx.client()).createDestination(
        await ctx.orgId(),
        def({ name, url, kind: kind as "fab" | "distributor" | "manual" | undefined, baseId: str(v, "base") }),
      );
      ctx.print({ destination }, () => `Added destination ${destination.name} (${destination.id}).`);
    },
  },

  /* ---------- carts ---------- */
  "carts list": {
    usage: "fabplane carts list [--repo URL] [--project ID]",
    summary: "List carts, optionally by repo or project",
    options: { repo: { type: "string" }, project: { type: "string" } },
    async run(ctx, _args, v) {
      const { carts } = await (await ctx.client()).listCarts(await ctx.orgId(), def({ repo: str(v, "repo"), projectId: str(v, "project") }));
      ctx.print({ carts }, () => table(carts, [["id", "id"], ["name", "name"], ["itemCount", "items"], ["fabDestinationId", "fab"], ["repos", "repos"], ["projectId", "project"], ["updatedAt", "updated"]]));
    },
  },
  "carts show": {
    usage: "fabplane carts show <cartId>",
    summary: "Show a cart and its items",
    async run(ctx, args) {
      const { cart } = await (await ctx.client()).getCart(await ctx.orgId(), need(args, 0, "cartId"));
      ctx.print({ cart }, () =>
        [
          keyValues([
            ["cart", `${cart.name} (${cart.id})`],
            ["fab", cart.fabDestinationId],
            ["repos", cart.repos.join(", ")],
            ["project", cart.projectId],
            ["notes", cart.notes],
          ]),
          "",
          table(cart.items, [["id", "id"], ["quantity", "qty"], ["mpn", "mpn"], ["manufacturer", "mfr"], ["description", "description"], ["refs", "refs"], ["destinationId", "destination"], ["sku", "sku"], ["status", "status"]]),
          "",
          ...cart.byDestination.map((d) => `${d.destinationId}: ${d.itemCount} line(s), ${d.totalQuantity} pcs`),
        ].join("\n"),
      );
    },
  },
  "carts create": {
    usage: "fabplane carts create <name> [--repo URL ...] [--project ID] [--notes TEXT] [--fab builtin:jlcpcb]",
    summary: "Create a cart",
    options: { repo: { type: "string", multiple: true }, project: { type: "string" }, notes: { type: "string" }, fab: { type: "string" } },
    async run(ctx, args, v) {
      const name = need(args, 0, "name");
      const { cart } = await (await ctx.client()).createCart(
        await ctx.orgId(),
        def({ name, repos: list(v, "repo"), projectId: str(v, "project"), notes: str(v, "notes"), fabDestinationId: str(v, "fab") }),
      );
      ctx.print({ cart }, () => `Created cart ${cart.name} (${cart.id}).`);
    },
  },
  "carts delete": {
    usage: "fabplane carts delete <cartId>",
    summary: "Delete a cart",
    async run(ctx, args) {
      const id = need(args, 0, "cartId");
      await (await ctx.client()).deleteCart(await ctx.orgId(), id);
      ctx.print({ ok: true, id }, () => `Deleted cart ${id}.`);
    },
  },
  "carts add": {
    usage: "fabplane carts add <cartId> --mpn MPN --qty N [--dest ID] [--manufacturer M] [--description D] [--refs R1,R2] [--sku S] [--url U] [--price P --currency USD] [--kind part|pcb|other] [--notes T]",
    summary: "Add one item to a cart",
    options: {
      mpn: { type: "string" },
      qty: { type: "string" },
      dest: { type: "string" },
      manufacturer: { type: "string" },
      description: { type: "string" },
      value: { type: "string" },
      footprint: { type: "string" },
      refs: { type: "string" },
      sku: { type: "string" },
      url: { type: "string" },
      price: { type: "string" },
      currency: { type: "string" },
      kind: { type: "string" },
      status: { type: "string" },
      notes: { type: "string" },
    },
    async run(ctx, args, v) {
      const cartId = need(args, 0, "cartId");
      const quantity = int(str(v, "qty"), "qty");
      if (quantity === undefined) throw new UsageError("--qty is required");
      if (!str(v, "mpn") && !str(v, "description") && !str(v, "sku")) throw new UsageError("Give at least --mpn, --sku or --description");
      const item = def({
        quantity,
        mpn: str(v, "mpn"),
        destinationId: str(v, "dest"),
        manufacturer: str(v, "manufacturer"),
        description: str(v, "description"),
        value: str(v, "value"),
        footprint: str(v, "footprint"),
        refs: str(v, "refs")?.split(/[\s,;]+/).filter(Boolean),
        sku: str(v, "sku"),
        url: str(v, "url"),
        unitPrice: num(str(v, "price"), "price"),
        currency: str(v, "currency"),
        kind: str(v, "kind") as CartItemInput["kind"],
        status: str(v, "status") as CartItemInput["status"],
        notes: str(v, "notes"),
      }) as CartItemInput;
      const res = await (await ctx.client()).addCartItems(await ctx.orgId(), cartId, [item]);
      const added = res.items[0];
      ctx.print(res, () => `Added ${added?.quantity ?? quantity}× ${added?.mpn ?? added?.description ?? "item"} → ${added?.destinationId ?? "?"} (item ${added?.id ?? "?"}).`);
    },
  },
  "carts import": {
    usage: "fabplane carts import <cartId> <file.json|file.csv|-> [--replace] [--source NAME]",
    summary: "Add (or with --replace, replace) cart items from JSON/JSONL/CSV",
    options: { replace: { type: "boolean" }, source: { type: "string" }, format: { type: "string" } },
    async run(ctx, args, v) {
      const cartId = need(args, 0, "cartId");
      const file = need(args, 1, "file");
      const text = await ctx.readText(file);
      const format = str(v, "format") ?? (extname(file).toLowerCase() === ".csv" ? "csv" : "json");
      const items = format === "csv" ? cartItemsFromCsv(text) : cartItemsFromJson(text);
      if (items.length === 0) throw new UsageError(`No items in ${file}`);
      const client = await ctx.client();
      const orgId = await ctx.orgId();
      if (v["replace"]) {
        if (items.length > 2000) throw new UsageError("--replace takes at most 2000 items");
        const { cart } = await client.replaceCartItems(orgId, cartId, items, str(v, "source"));
        ctx.print({ cart }, () => `Replaced items of ${cart.name}: ${cart.items.length} line(s).`);
        return;
      }
      let added = 0;
      for (const batch of chunks(items, IMPORT_CHUNK)) added += (await client.addCartItems(orgId, cartId, batch)).items.length;
      ctx.print({ ok: true, added }, () => `Added ${added} item(s) to cart ${cartId}.`);
    },
  },
  "carts export": {
    usage: "fabplane carts export <cartId> [--dest ID] [--output file.csv]",
    summary: "Export a cart as CSV (optionally one destination)",
    options: { dest: { type: "string" }, output: { type: "string", short: "o" } },
    async run(ctx, args, v) {
      const cartId = need(args, 0, "cartId");
      const csv = await (await ctx.client()).exportCartCsv(await ctx.orgId(), cartId, def({ destinationId: str(v, "dest") }));
      const output = str(v, "output");
      if (output) {
        await writeFile(ctx.path(output), csv);
        ctx.print({ ok: true, output: ctx.path(output) }, () => `Wrote ${ctx.path(output)}.`);
      } else if (ctx.json) ctx.io.stdout(JSON.stringify({ csv }, null, 2));
      else ctx.io.stdout(csv.replace(/\n$/, ""));
    },
  },

  /* ---------- inventory ---------- */
  "inventory list": {
    usage: "fabplane inventory list [--q TEXT] [--category C] [--location L] [--tag T] [--limit N] [--cursor C] [--all]",
    summary: "List/search inventory",
    options: { q: { type: "string" }, category: { type: "string" }, location: { type: "string" }, tag: { type: "string" }, limit: { type: "string" }, cursor: { type: "string" }, all: { type: "boolean" } },
    async run(ctx, _args, v) {
      const client = await ctx.client();
      const orgId = await ctx.orgId();
      const query = def({ q: str(v, "q"), category: str(v, "category"), location: str(v, "location"), tag: str(v, "tag"), limit: int(str(v, "limit"), "limit"), cursor: str(v, "cursor") });
      let res = await client.listInventory(orgId, query);
      const items = [...res.items];
      while (v["all"] && res.nextCursor) {
        res = await client.listInventory(orgId, { ...query, cursor: res.nextCursor });
        items.push(...res.items);
      }
      const nextCursor = v["all"] ? null : res.nextCursor;
      ctx.print({ items, nextCursor }, () =>
        table(items, [["id", "id"], ["name", "name"], ["mpn", "mpn"], ["quantity", "qty"], ["unit", "unit"], ["location", "location"], ["category", "category"], ["tags", "tags"]]) +
        (nextCursor ? `\n(more: --cursor ${nextCursor} or --all)` : ""),
      );
    },
  },
  "inventory show": {
    usage: "fabplane inventory show <id>",
    summary: "Show one inventory item",
    async run(ctx, args) {
      const { item } = await (await ctx.client()).getInventoryItem(await ctx.orgId(), need(args, 0, "id"));
      ctx.print({ item }, () =>
        keyValues([
          ["item", `${item.name} (${item.id})`],
          ["mpn", item.mpn],
          ["manufacturer", item.manufacturer],
          ["sku", item.sku],
          ["category", item.category],
          ["quantity", `${item.quantity} ${item.unit}`],
          ["location", item.location],
          ["tags", item.tags],
          ["description", item.description],
          ["source", item.externalId ? `${item.source ?? ""} ${item.externalId}` : item.source],
          ...Object.entries(item.attributes).map(([k, val]): [string, unknown] => [`  ${k}`, val]),
          ["images", item.images.length ? item.images.map((i) => i.id) : undefined],
        ]),
      );
    },
  },
  "inventory add": {
    usage: "fabplane inventory add --name NAME [--mpn M] [--manufacturer M] [--sku S] [--category C] [--description D] [--qty N] [--unit pcs] [--location L] [--tag T ...] [--attr k=v ...] [--source S] [--external-id ID] [--image path ...] [--server-ai]",
    summary: "Add an inventory item (optionally with photos)",
    options: {
      name: { type: "string" },
      mpn: { type: "string" },
      manufacturer: { type: "string" },
      sku: { type: "string" },
      category: { type: "string" },
      description: { type: "string" },
      qty: { type: "string" },
      unit: { type: "string" },
      location: { type: "string" },
      tag: { type: "string", multiple: true },
      attr: { type: "string", multiple: true },
      source: { type: "string" },
      "external-id": { type: "string" },
      image: { type: "string", multiple: true },
      "server-ai": { type: "boolean" },
    },
    async run(ctx, _args, v) {
      const name = str(v, "name");
      if (!name) throw new UsageError("--name is required");
      const attributes: Record<string, AttributeValue> = {};
      for (const pair of list(v, "attr")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new UsageError(`--attr expects key=value (got "${pair}")`);
        attributes[pair.slice(0, eq).trim()] = attrValue(pair.slice(eq + 1).trim());
      }
      const input = def({
        name,
        mpn: str(v, "mpn"),
        manufacturer: str(v, "manufacturer"),
        sku: str(v, "sku"),
        category: str(v, "category"),
        description: str(v, "description"),
        quantity: int(str(v, "qty"), "qty"),
        unit: str(v, "unit"),
        location: str(v, "location"),
        tags: list(v, "tag"),
        attributes: Object.keys(attributes).length ? attributes : undefined,
        source: str(v, "source") ?? "fabplane-cli",
        externalId: str(v, "external-id"),
        serverAiProcessing: v["server-ai"] ? true : undefined,
      }) as InventoryItemInput;
      const images: ImageUpload[] = [];
      for (const p of list(v, "image")) {
        const contentType = IMAGE_TYPES[extname(p).toLowerCase()];
        if (!contentType) throw new UsageError(`${p}: unsupported image type (png, jpeg, webp, gif, heic, heif)`);
        const data = await readFile(ctx.path(p));
        images.push({ data: new Uint8Array(data), contentType, filename: p.split(/[\\/]/).pop() ?? "image" });
      }
      const { item } = await (await ctx.client()).createInventoryItem(await ctx.orgId(), input, images);
      ctx.print({ item }, () => `Saved ${item.name} (${item.id}): ${item.quantity} ${item.unit}${item.images.length ? `, ${item.images.length} image(s)` : ""}.`);
    },
  },
  "inventory import": {
    usage: "fabplane inventory import <file.jsonl|-> [--source NAME]",
    summary: "Bulk upsert items from JSONL (500 per request, keyed by externalId)",
    options: { source: { type: "string" } },
    async run(ctx, args, v) {
      const file = need(args, 0, "file.jsonl");
      const rows = parseJsonl<InventoryItemInput>(await ctx.readText(file));
      if (rows.length === 0) throw new UsageError(`No items in ${file}`);
      const source = str(v, "source");
      const items = rows.map((row, i) => {
        if (!row || typeof row !== "object" || typeof row.name !== "string" || !row.name) throw new UsageError(`Line ${i + 1}: "name" is required`);
        const withSource = { ...row, source: row.source ?? source ?? "fabplane-cli" };
        return withSource.externalId ? withSource : { ...withSource, externalId: derivedExternalId(withSource) };
      });
      const client = await ctx.client();
      const orgId = await ctx.orgId();
      let created = 0;
      let updated = 0;
      let batchNo = 0;
      const batches = chunks(items, IMPORT_CHUNK);
      for (const batch of batches) {
        batchNo++;
        const res = await client.bulkUpsertInventory(orgId, batch);
        created += res.created;
        updated += res.updated;
        if (!ctx.json && batches.length > 1) ctx.info(`batch ${batchNo}/${batches.length}: +${res.created} new, ${res.updated} updated`);
      }
      ctx.print({ ok: true, total: items.length, created, updated }, () => `Imported ${items.length} item(s): ${created} created, ${updated} updated.`);
    },
  },
  "inventory adjust": {
    usage: "fabplane inventory adjust <id> <delta> [--reason TEXT]",
    summary: "Add/subtract stock atomically (e.g. -5)",
    options: { reason: { type: "string" } },
    async run(ctx, args, v) {
      const id = need(args, 0, "id");
      const delta = int(need(args, 1, "delta"), "delta");
      if (!delta) throw new UsageError("<delta> must be a non-zero integer");
      const { item } = await (await ctx.client()).adjustInventory(await ctx.orgId(), id, delta, str(v, "reason"));
      ctx.print({ item }, () => `${item.name}: ${item.quantity} ${item.unit} (${delta > 0 ? "+" : ""}${delta}).`);
    },
  },
  "inventory delete": {
    usage: "fabplane inventory delete <id>",
    summary: "Delete an inventory item and its images",
    async run(ctx, args) {
      const id = need(args, 0, "id");
      await (await ctx.client()).deleteInventoryItem(await ctx.orgId(), id);
      ctx.print({ ok: true, id }, () => `Deleted inventory item ${id}.`);
    },
  },

  /* ---------- mcp ---------- */
  mcp: {
    usage: "fabplane mcp [--desktop]",
    summary: "Run the stdio MCP server (for Claude Code, Codex, Cursor…)",
    options: { desktop: { type: "boolean" } },
    async run(ctx, _args, v) {
      const auth = await ctx.auth();
      if (!auth.token) ctx.info(`fabplane mcp: not logged in to ${auth.origin}; fabplane tools will fail until you run \`fabplane login\` or set FABPLANE_TOKEN.`);
      const client = ctx.newClient(auth.origin, auth.token);
      const opts: FabplaneMcpOptions = {
        client,
        orgId: () => resolveDefaultOrg(client, { explicit: auth.orgId, env: {} }),
        ...(v["desktop"] ? { desktop: ctx.fabdesk() } : {}),
      };
      await (ctx.io.runMcp ?? runMcpStdio)(opts);
    },
  },

  /* ---------- desktop ---------- */
  "desktop status": {
    usage: "fabplane desktop status",
    summary: "Is the fabPlane desktop app running? (reads daemon.json)",
    async run(ctx) {
      const desk = ctx.fabdesk();
      const conn = await desk.connection();
      const health = await desk.health();
      const auth = await desk.authState().catch(() => null);
      ctx.print({ baseUrl: conn.baseUrl, handshake: conn.handshake ? { ...conn.handshake, token: "***" } : null, health, auth }, () =>
        keyValues([
          ["fabdesk", `${health.version ?? "?"} at ${conn.baseUrl}`],
          ["pid", health.pid],
          ["channel", health.channel],
          ["auth", auth ? `${auth.mode} / ${auth.status}${auth.principal ? ` as ${auth.principal.handle ?? auth.principal.subject}` : ""}` : undefined],
        ]),
      );
    },
  },
  "desktop projects": {
    usage: "fabplane desktop projects",
    summary: "List fabdesk projects",
    async run(ctx) {
      const projects = await ctx.fabdesk().projects();
      ctx.print({ projects }, () => table(projects, [["id", "id"], ["name", "name"], ["updatedAt", "updated"]]));
    },
  },
  "desktop tools": {
    usage: "fabplane desktop tools",
    summary: "List fabdesk tools",
    async run(ctx) {
      const tools = await ctx.fabdesk().toolManifest();
      ctx.print({ tools }, () => table(tools, [["name", "name"], ["toolset", "toolset"], ["title", "title"], ["longRunning", "long"]]));
    },
  },
  "desktop call": {
    usage: "fabplane desktop call <tool> [json-args] [--project ID] [--sync]",
    summary: "Call a fabdesk tool",
    options: { project: { type: "string" }, sync: { type: "boolean" } },
    async run(ctx, args, v) {
      const name = need(args, 0, "tool");
      const raw = args[1] === "-" ? await ctx.readText("-") : args[1];
      const toolArgs = raw ? parseJsonArg(raw, "json-args") : {};
      if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) throw new UsageError("json-args must be a JSON object");
      const res = await ctx.fabdesk().callTool(name, toolArgs as Record<string, unknown>, def({ projectId: str(v, "project"), sync: v["sync"] === true ? true : undefined }));
      ctx.print(res, () => (res.jobId ? `Queued as job ${res.jobId}` : (res.text ?? JSON.stringify(res.json ?? res, null, 2))));
      if (res.ok === false) throw new SilentFailure();
    },
  },

  /* ---------- raw ---------- */
  api: {
    usage: "fabplane api <METHOD> <path> [json|-] [--anonymous]",
    summary: "Raw authenticated request (escape hatch)",
    options: { anonymous: { type: "boolean" } },
    async run(ctx, args, v) {
      const method = need(args, 0, "METHOD").toUpperCase();
      let path = need(args, 1, "path");
      if (!path.startsWith("/")) path = `/${path}`;
      const auth = await ctx.auth();
      const client = v["anonymous"] ? ctx.newClient(auth.origin) : await ctx.client();
      const raw = args[2] === "-" ? await ctx.readText("-") : args[2];
      const json = raw !== undefined ? parseJsonArg(raw, "body") : undefined;
      const [pathname, search] = path.split("?", 2) as [string, string | undefined];
      const query = Object.fromEntries(new URLSearchParams(search ?? ""));
      const res = await client.raw(method, pathname, { ...(json !== undefined ? { json } : {}), query });
      const text = res.status === 204 ? "" : await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (ctx.json) ctx.io.stdout(JSON.stringify({ status: res.status, body }, null, 2));
      else if (text) ctx.io.stdout(typeof body === "string" ? body : JSON.stringify(body, null, 2));
      if (!res.ok) {
        ctx.info(`HTTP ${res.status}`);
        throw new SilentFailure();
      }
    },
  },

  version: {
    usage: "fabplane version",
    summary: "Print the version",
    async run(ctx) {
      ctx.print({ version: VERSION }, () => VERSION);
    },
  },
};

class SilentFailure extends Error {}

function derivedExternalId(item: InventoryItemInput): string {
  const key = [item.name, item.mpn, item.manufacturer, item.sku, item.location].map((s) => (s ?? "").trim().toLowerCase()).join("|");
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export function helpText(topic?: string): string {
  if (topic) {
    const matching = Object.entries(commands).filter(([k]) => k === topic || k.startsWith(`${topic} `));
    if (matching.length) return matching.map(([, c]) => `${c.usage}\n    ${c.summary}`).join("\n");
  }
  const rows = Object.entries(commands).map(([, c]) => {
    const words: string[] = [];
    for (const w of c.usage.replace(/^fabplane /, "").split(" ")) {
      if (w.startsWith("[") || w.startsWith("--")) break;
      words.push(w);
    }
    return `  ${words.join(" ").padEnd(34)} ${c.summary}`;
  });
  return [
    `fabplane ${VERSION}: CLI and MCP server for fabplane.com`,
    "",
    "Usage: fabplane <command> [options]",
    "",
    "Commands:",
    ...rows,
    "  help [command]                     Show help",
    "",
    "Global options:",
    "  --json            Machine-readable JSON output",
    "  --org ID|SLUG     Org to act on (default: FABPLANE_ORG, `orgs use`, else your personal org)",
    "  --origin URL      API origin (default: FABPLANE_API_ORIGIN, the last login, else https://api.fabplane.com)",
    "",
    "Environment: FABPLANE_TOKEN, FABPLANE_API_ORIGIN, FABPLANE_ORG, FABDESK_HOME",
    "Docs: https://fabplane.com/docs/cli",
  ].join("\n");
}

/** Replaces negative numbers (`-5`) so parseArgs keeps them as positionals. */
const NEG = "\u0000neg:";

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const words: number[] = [];
  for (let i = 0; i < argv.length && words.length < 2; i++) {
    const a = argv[i] ?? "";
    if (a === "--") break;
    if (a.startsWith("-")) {
      const name = a.replace(/^-+/, "").split("=")[0] ?? "";
      if (!a.includes("=") && (name === "org" || name === "origin")) i++;
      continue;
    }
    if (words.length === 0) words.push(i);
    else if (GROUPS.has(argv[words[0]!] ?? "")) words.push(i);
    else break;
  }
  const cmdWords = words.map((i) => argv[i] ?? "");
  const rest = argv.filter((_, i) => !words.includes(i)).map((a) => (/^-\d+(\.\d+)?$/.test(a) ? `${NEG}${a}` : a));
  const first = cmdWords[0];

  const wantsJson = argv.includes("--json");
  const fail = (code: number, message: string, extra: Record<string, unknown> = {}): number => {
    io.stderr(wantsJson ? JSON.stringify({ error: extra["error"] ?? "error", message, ...extra }) : `Error: ${message}`);
    return code;
  };

  if (!first) {
    io.stdout(argv.includes("--version") || argv.includes("-v") ? VERSION : helpText());
    return 0;
  }
  if (first === "help") {
    const topic = argv.slice(words[0]! + 1).filter((a) => !a.startsWith("-")).join(" ");
    io.stdout(helpText(topic || undefined));
    return 0;
  }
  const key = cmdWords.join(" ");
  const command = commands[key];
  if (!command) {
    if (first && GROUPS.has(first)) {
      io.stderr(`${cmdWords[1] ? `Unknown command "${key}". ` : ""}Usage:\n${helpText(first)}`);
      return 2;
    }
    io.stderr(`Unknown command "${first}". Run \`fabplane help\`.`);
    return 2;
  }

  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) } as never,
      allowPositionals: true,
      strict: true,
    }) as unknown as { values: Values; positionals: string[] };
  } catch (err) {
    return fail(2, `${err instanceof Error ? err.message : String(err)}\nUsage: ${command.usage}`, { error: "usage" });
  }
  const values = parsed.values;
  const positionals = parsed.positionals.map((p) => (p.startsWith(NEG) ? p.slice(NEG.length) : p));
  if (values["help"]) {
    io.stdout(`${command.usage}\n    ${command.summary}`);
    return 0;
  }
  const ctx = new Ctx(io, values["json"] === true, def({ org: str(values, "org"), origin: str(values, "origin") }));
  try {
    await command.run(ctx, positionals, values);
    return 0;
  } catch (err) {
    if (err instanceof SilentFailure) return 1;
    if (err instanceof UsageError) return fail(2, `${err.message}${err.message.startsWith("Not logged in") ? "" : `\nUsage: ${command.usage}`}`, { error: "usage" });
    if (err instanceof FabplaneApiError) {
      if (err.code === "server_ai_unavailable" || err.status === 501) {
        return fail(
          1,
          `Server-side AI processing is not available yet (HTTP 501 server_ai_unavailable).\n` +
            `Nothing was stored. Extract the fields locally (for example with a local model reading the photo or label) ` +
            `and send them as --mpn/--manufacturer/--attr k=v without --server-ai.` +
            (err.message && !/not available yet/i.test(err.message) ? `\nServer said: ${err.message}` : ""),
          { error: err.code, status: err.status },
        );
      }
      const hint = err.status === 401 ? "\nRun `fabplane login` (or check FABPLANE_TOKEN)." : err.status === 403 ? "\nYour role in this org does not allow that." : "";
      return fail(1, `${err.message} (HTTP ${err.status} ${err.code})${hint}`, { error: err.code, status: err.status });
    }
    if (err instanceof FabdeskError) return fail(1, err.message, { error: "fabdesk", status: err.status });
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === "ENOENT" && e.path) return fail(1, `File not found: ${e.path}`, { error: "not_found" });
    if (e instanceof TypeError && /fetch failed/i.test(e.message)) {
      const auth = await ctx.auth().catch(() => null);
      return fail(1, `Cannot reach ${auth?.origin ?? "the API"}: ${String((e as { cause?: unknown }).cause ?? e.message)}`, { error: "network" });
    }
    return fail(1, err instanceof Error ? err.message : String(err));
  }
}
