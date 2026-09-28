/**
 * Credentials: env `FABPLANE_TOKEN` / `FABPLANE_API_ORIGIN` / `FABPLANE_ORG` win; otherwise
 * `credentials.json` in the fabplane config dir (`$XDG_CONFIG_HOME/fabplane`, default
 * `~/.config/fabplane`; `%APPDATA%\fabplane` on Windows), written atomically with mode 0600.
 * One profile is kept per API origin so production and a staging/local API can coexist.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FabplaneClient } from "./client.js";
import { DEFAULT_API_ORIGIN, normalizeOrigin } from "./origin.js";
import type { Org } from "./types.js";

export type Env = Record<string, string | undefined>;

export type Profile = {
  token: string;
  /** `device` = `fpd_…` from the browser login; `api` = `fpk_…` personal token. */
  tokenKind?: "device" | "api";
  expiresAt?: string | null;
  defaultOrgId?: string;
  user?: { subject?: string; handle?: string; displayName?: string; email?: string | null };
  savedAt?: string;
};

export type CredentialsFile = {
  version: 1;
  /** The origin `fabplane` talks to when `FABPLANE_API_ORIGIN` is unset. */
  currentOrigin?: string;
  profiles: Record<string, Profile>;
};

export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (platform === "win32") {
    const appData = env["APPDATA"] && env["APPDATA"] !== "" ? env["APPDATA"] : join(home, "AppData", "Roaming");
    return join(appData, "fabplane");
  }
  const xdg = env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"] !== "" ? env["XDG_CONFIG_HOME"] : join(home, ".config");
  return join(xdg, "fabplane");
}

export function credentialsPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env["FABPLANE_CREDENTIALS_FILE"];
  if (override && override.trim() !== "") return override;
  return join(configDir(env, platform), "credentials.json");
}

export function tokenKindOf(token: string): "device" | "api" | undefined {
  if (token.startsWith("fpk_")) return "api";
  if (token.startsWith("fpd_")) return "device";
  return undefined;
}

export class CredentialStore {
  readonly path: string;

  constructor(opts: { path?: string; env?: Env; platform?: NodeJS.Platform } = {}) {
    this.path = opts.path ?? credentialsPath(opts.env ?? process.env, opts.platform ?? process.platform);
  }

  async read(): Promise<CredentialsFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Partial<CredentialsFile>;
      const profiles = parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
      return {
        version: 1,
        ...(typeof parsed.currentOrigin === "string" ? { currentOrigin: parsed.currentOrigin } : {}),
        profiles,
      };
    } catch {
      return { version: 1, profiles: {} };
    }
  }

  /** Writes to a temp file (0600) in the same directory and renames it over the old one. */
  async write(file: CredentialsFile): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => undefined);
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async getProfile(origin: string): Promise<Profile | undefined> {
    const file = await this.read();
    return file.profiles[normalizeOrigin(origin)];
  }

  /** Stores (merges) the profile for `origin` and makes it the current origin. */
  async saveProfile(origin: string, profile: Partial<Profile> & { token?: string }, opts: { makeCurrent?: boolean } = {}): Promise<Profile> {
    const key = normalizeOrigin(origin);
    const file = await this.read();
    const prev = file.profiles[key];
    const token = profile.token ?? prev?.token;
    if (!token) throw new Error(`No token stored for ${key}; run \`fabplane login\``);
    const next: Profile = { ...prev, ...profile, token, savedAt: new Date().toISOString() };
    file.profiles[key] = next;
    if (opts.makeCurrent !== false) file.currentOrigin = key;
    await this.write(file);
    return next;
  }

  async removeProfile(origin: string): Promise<boolean> {
    const key = normalizeOrigin(origin);
    const file = await this.read();
    if (!file.profiles[key]) return false;
    delete file.profiles[key];
    if (file.currentOrigin === key) delete file.currentOrigin;
    await this.write(file);
    return true;
  }
}

export type ResolvedAuth = {
  origin: string;
  token: string | undefined;
  /** Where the token came from. */
  tokenSource: "env" | "file" | "flag" | "none";
  /** Org from `FABPLANE_ORG` or the stored default; the personal org is resolved lazily. */
  orgId: string | undefined;
  orgSource: "env" | "file" | "flag" | "none";
  profile: Profile | undefined;
};

/**
 * Where to talk and with which token: flags > env > the credentials file's current origin > the
 * production API. An env/flag token always wins over a stored one.
 */
export async function resolveAuth(opts: {
  env?: Env;
  store?: CredentialStore;
  origin?: string;
  token?: string;
  org?: string;
} = {}): Promise<ResolvedAuth> {
  const env = opts.env ?? process.env;
  const store = opts.store ?? new CredentialStore({ env });
  const file = await store.read();
  const originRaw = opts.origin ?? nonEmpty(env["FABPLANE_API_ORIGIN"]) ?? file.currentOrigin ?? DEFAULT_API_ORIGIN;
  const origin = normalizeOrigin(originRaw);
  const profile = file.profiles[origin];
  const envToken = nonEmpty(env["FABPLANE_TOKEN"]);
  const storedToken = profile && !isExpired(profile) ? profile.token : undefined;
  const token = opts.token ?? envToken ?? storedToken;
  const tokenSource = opts.token ? "flag" : envToken ? "env" : storedToken ? "file" : "none";
  const envOrg = nonEmpty(env["FABPLANE_ORG"]);
  const orgId = opts.org ?? envOrg ?? profile?.defaultOrgId;
  const orgSource = opts.org ? "flag" : envOrg ? "env" : profile?.defaultOrgId ? "file" : "none";
  return { origin, token, tokenSource, orgId, orgSource, profile };
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function isExpired(profile: Profile): boolean {
  return Boolean(profile.expiresAt && Date.parse(profile.expiresAt) <= Date.now());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for strings shaped like the API's UUID ids. */
export function looksLikeId(value: string): boolean {
  return UUID_RE.test(value);
}

/** Finds an org by id or slug among the caller's memberships. */
export function findOrg(orgs: Org[], idOrSlug: string): Org | undefined {
  const needle = idOrSlug.trim().toLowerCase();
  return orgs.find((o) => o.id.toLowerCase() === needle) ?? orgs.find((o) => o.slug.toLowerCase() === needle);
}

/**
 * The org to act on: an explicit id/slug (slugs are resolved through `listOrgs`), else
 * `FABPLANE_ORG`, else the stored `defaultOrgId`, else the caller's personal org.
 */
export async function resolveDefaultOrg(
  client: FabplaneClient,
  opts: { explicit?: string | undefined; env?: Env; defaultOrgId?: string | undefined } = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const wanted = opts.explicit ?? nonEmpty(env["FABPLANE_ORG"]) ?? opts.defaultOrgId;
  if (wanted && looksLikeId(wanted)) return wanted;
  const { orgs } = await client.listOrgs();
  if (wanted) {
    const org = findOrg(orgs, wanted);
    if (!org) throw new Error(`No org "${wanted}" among your memberships (${orgs.map((o) => o.slug).join(", ") || "none"})`);
    return org.id;
  }
  const personal = orgs.find((o) => o.personal) ?? orgs[0];
  if (!personal) throw new Error("You are not a member of any org");
  return personal.id;
}
