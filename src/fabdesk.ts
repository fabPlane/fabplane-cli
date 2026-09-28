/**
 * Client for the local fabdesk desktop daemon (fabdesk-core). The daemon writes `daemon.json`
 * (`{ version, pid, port, host, token, startedAt, channel, authMode }`) when it listens; this
 * client finds that file, then calls the loopback HTTP API with the bearer token.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./credentials.js";
import type { FetchLike } from "./client.js";

export type DaemonHandshake = {
  version: string;
  pid: number;
  port: number;
  host: string;
  token: string;
  startedAt: string;
  channel?: "public" | "internal";
  authMode?: "fabplane" | "local";
};

export type FabdeskHealth = {
  ok: boolean;
  version?: string;
  pid?: number;
  channel?: string;
  authMode?: string;
  uptimeMs?: number;
  [key: string]: unknown;
};

export type FabdeskProject = { id: string; name: string; [key: string]: unknown };
export type FabdeskThread = { id: string; title?: string; agentId?: string; projectId?: string | null; [key: string]: unknown };
export type FabdeskToolManifestEntry = {
  name: string;
  toolset: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  longRunning: boolean;
};
/** `POST /tools/:name`: a finished call, or `{ jobId }` for a queued long-running one. */
export type FabdeskToolResult =
  | { ok: boolean; text: string; json?: unknown; images?: Array<{ path: string; mime: string }>; jobId?: undefined }
  | { jobId: string; ok?: undefined; text?: undefined; json?: undefined };
export type FabdeskJob = {
  id: string;
  kind: string;
  projectId: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | string;
  progress: number | null;
  note: string | null;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
};
export type FabdeskAuthState = {
  mode: "fabplane" | "local";
  status: "signed_out" | "pending" | "signed_in" | "error";
  principal?: { subject: string; handle?: string; displayName?: string; email?: string };
  error?: string;
  [key: string]: unknown;
};
export type FabdeskLiveRun = { runId: string; threadId: string; agentId: string; startedAt: string };

export class FabdeskError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;
  constructor(status: number, path: string, message: string, body?: unknown) {
    super(message);
    this.name = "FabdeskError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** Parent of per-app data dirs: `~/Library/Application Support`, `%APPDATA%`, `$XDG_CONFIG_HOME`. */
export function appDataDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env["APPDATA"] && env["APPDATA"] !== "" ? env["APPDATA"] : join(home, "AppData", "Roaming");
  return env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"] !== "" ? env["XDG_CONFIG_HOME"] : join(home, ".config");
}

/** fabdesk's home: `FABDESK_HOME`, else `<appData>/fabdesk`. */
export function fabdeskHome(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env["FABDESK_HOME"];
  if (override && override.trim() !== "") return override;
  return join(appDataDir(env, platform), "fabdesk");
}

/**
 * Where a running daemon may have written `daemon.json`, most specific first. The desktop app
 * writes it into its Electron userData dir (`fabPlane`, or `fabPlane Dev` for a dev build); a
 * daemon started on its own writes it into the fabdesk home (`fabdesk`, `fabdesk-dev`).
 */
export function daemonFileCandidates(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const explicit = env["FABDESK_DAEMON_FILE"];
  if (explicit && explicit.trim() !== "") return [explicit];
  const out: string[] = [];
  const home = env["FABDESK_HOME"];
  if (home && home.trim() !== "") out.push(join(home, "daemon.json"));
  const base = appDataDir(env, platform);
  for (const dir of ["fabPlane", "fabdesk", "fabPlane Dev", "fabdesk-dev"]) out.push(join(base, dir, "daemon.json"));
  return [...new Set(out)];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseHandshake(text: string): DaemonHandshake | null {
  try {
    const v = JSON.parse(text) as Partial<DaemonHandshake>;
    if (typeof v.port !== "number" || typeof v.token !== "string" || !v.token) return null;
    return {
      version: typeof v.version === "string" ? v.version : "unknown",
      pid: typeof v.pid === "number" ? v.pid : 0,
      port: v.port,
      host: typeof v.host === "string" && v.host ? v.host : "127.0.0.1",
      token: v.token,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
      ...(v.channel ? { channel: v.channel } : {}),
      ...(v.authMode ? { authMode: v.authMode } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Reads the first `daemon.json` whose process is alive (falling back to the newest file found
 * when none is). Returns null when no fabdesk daemon has ever run here.
 */
export async function findDaemonHandshake(
  opts: { env?: Env; platform?: NodeJS.Platform; candidates?: string[]; checkPid?: boolean } = {},
): Promise<(DaemonHandshake & { file: string; alive: boolean }) | null> {
  const env = opts.env ?? process.env;
  const candidates = opts.candidates ?? daemonFileCandidates(env, opts.platform ?? process.platform);
  const found: Array<DaemonHandshake & { file: string; alive: boolean }> = [];
  for (const file of candidates) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const hs = parseHandshake(text);
    if (!hs) continue;
    const alive = opts.checkPid === false ? true : hs.pid > 0 && pidAlive(hs.pid);
    if (alive) return { ...hs, file, alive };
    found.push({ ...hs, file, alive });
  }
  found.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return found[0] ?? null;
}

export interface FabdeskClientOptions {
  /** `http://127.0.0.1:<port>`; with `token`, skips `daemon.json` discovery. Env: `FABDESK_URL`. */
  baseUrl?: string;
  /** Daemon bearer token. Env: `FABDESK_TOKEN` (with `FABDESK_URL`). */
  token?: string;
  /** Read this `daemon.json` instead of searching the default locations. */
  handshakeFile?: string;
  env?: Env;
  platform?: NodeJS.Platform;
  fetch?: FetchLike;
}

export class FabdeskClient {
  private readonly opts: FabdeskClientOptions;
  private readonly fetchImpl: FetchLike;
  private resolved: { baseUrl: string; token: string; handshake: DaemonHandshake | null } | null = null;

  constructor(opts: FabdeskClientOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Base URL + token, from options, `FABDESK_URL`/`FABDESK_TOKEN`, or `daemon.json`. */
  async connection(): Promise<{ baseUrl: string; token: string; handshake: DaemonHandshake | null }> {
    if (this.resolved) return this.resolved;
    const env = this.opts.env ?? process.env;
    const baseUrl = this.opts.baseUrl ?? env["FABDESK_URL"];
    const token = this.opts.token ?? env["FABDESK_TOKEN"];
    if (baseUrl && token) {
      this.resolved = { baseUrl: baseUrl.replace(/\/+$/, ""), token, handshake: null };
      return this.resolved;
    }
    const hs = await findDaemonHandshake({
      env,
      ...(this.opts.platform ? { platform: this.opts.platform } : {}),
      ...(this.opts.handshakeFile ? { candidates: [this.opts.handshakeFile] } : {}),
    });
    if (!hs) {
      throw new FabdeskError(0, "daemon.json", "fabdesk is not running: no daemon.json found. Start the fabPlane desktop app (or `fabdesk-core serve`), or set FABDESK_URL and FABDESK_TOKEN.");
    }
    const host = hs.host.includes(":") && !hs.host.startsWith("[") ? `[${hs.host}]` : hs.host;
    this.resolved = { baseUrl: `http://${host}:${hs.port}`, token: hs.token, handshake: hs };
    return this.resolved;
  }

  async request<T>(method: string, path: string, init: { json?: unknown; query?: Record<string, string | undefined>; auth?: boolean } = {}): Promise<T> {
    const { baseUrl, token } = await this.connection();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") qs.set(k, v);
    const url = `${baseUrl}${path}${qs.size ? `?${qs.toString()}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.auth !== false) headers["authorization"] = `Bearer ${token}`;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      });
    } catch (err) {
      const file = (this.resolved?.handshake as { file?: string } | null)?.file;
      const hint = file ? ` (address from ${file}; the desktop app may have exited: start it again)` : "";
      throw new FabdeskError(0, path, `Cannot reach the fabdesk daemon at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}${hint}`);
    }
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    if (text && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok && res.status !== 422) {
      const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : text || res.statusText;
      throw new FabdeskError(res.status, path, `fabdesk ${method} ${path} failed (${res.status}): ${msg}`, body);
    }
    return (text ? body : undefined) as T;
  }

  /** `GET /health` (no auth). */
  health(): Promise<FabdeskHealth> {
    return this.request("GET", "/health", { auth: false });
  }
  /** `GET /projects` */
  projects(): Promise<FabdeskProject[]> {
    return this.request("GET", "/projects");
  }
  /** `GET /projects/:id` */
  project(projectId: string): Promise<FabdeskProject> {
    return this.request("GET", `/projects/${encodeURIComponent(projectId)}`);
  }
  /** `POST /projects` */
  createProject(name: string): Promise<FabdeskProject> {
    return this.request("POST", "/projects", { json: { name } });
  }
  /** `GET /projects/:id/files/<path>` as text. */
  async readFile(projectId: string, path: string): Promise<string> {
    const clean = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    const body = await this.request<unknown>("GET", `/projects/${encodeURIComponent(projectId)}/files/${clean}`);
    return typeof body === "string" ? body : JSON.stringify(body);
  }
  /** `GET /threads` */
  threads(query: { q?: string; projectId?: string } = {}): Promise<FabdeskThread[]> {
    return this.request("GET", "/threads", { query: { q: query.q, projectId: query.projectId } });
  }
  /** `GET /threads/:id` */
  thread(threadId: string): Promise<FabdeskThread> {
    return this.request("GET", `/threads/${encodeURIComponent(threadId)}`);
  }
  /** `POST /threads` */
  createThread(input: { agentId: string; projectId?: string | null; title?: string; model?: string }): Promise<FabdeskThread> {
    return this.request("POST", "/threads", { json: input });
  }
  /** `GET /threads/:id/messages` */
  messages(threadId: string): Promise<Array<Record<string, unknown>>> {
    return this.request("GET", `/threads/${encodeURIComponent(threadId)}/messages`);
  }
  /** `POST /threads/:id/messages`: starts an agent run (202) or queues the message with `queue`. */
  sendMessage(
    threadId: string,
    text: string,
    opts: { agentId?: string; model?: string; queue?: boolean } = {},
  ): Promise<{ runId?: string; messageId: string; userMessageId?: string; queued?: boolean }> {
    return this.request("POST", `/threads/${encodeURIComponent(threadId)}/messages`, { json: { content: text, ...opts } });
  }
  /** `GET /runs/live` */
  liveRuns(): Promise<FabdeskLiveRun[]> {
    return this.request("GET", "/runs/live");
  }
  /** `GET /tools/manifest`: every fabdesk tool with its JSON-schema input. */
  toolManifest(): Promise<FabdeskToolManifestEntry[]> {
    return this.request("GET", "/tools/manifest");
  }
  /**
   * `POST /tools/:name`. Long-running tools answer `{ jobId }` unless `sync` is set. `projectId`
   * selects the project for project-scoped tools.
   */
  callTool(name: string, args: Record<string, unknown> = {}, opts: { projectId?: string; sync?: boolean } = {}): Promise<FabdeskToolResult> {
    return this.request("POST", `/tools/${encodeURIComponent(name)}`, {
      json: { args, ...(opts.projectId ? { project: opts.projectId } : {}) },
      ...(opts.sync ? { query: { sync: "1" } } : {}),
    });
  }
  /** `GET /jobs` */
  jobs(): Promise<FabdeskJob[]> {
    return this.request("GET", "/jobs");
  }
  /** `GET /jobs/:id` */
  job(jobId: string): Promise<FabdeskJob> {
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }
  /** `POST /jobs/:id/cancel` */
  cancelJob(jobId: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`);
  }
  /** Polls `GET /jobs/:id` until it is done, failed or cancelled. */
  async waitJob(jobId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<FabdeskJob> {
    const interval = opts.intervalMs ?? 750;
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const job = await this.job(jobId);
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job;
      if (Date.now() > deadline) return job;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  /** `GET /settings` */
  settings(): Promise<Record<string, unknown>> {
    return this.request("GET", "/settings");
  }
  /** `GET /v1/auth/state`: whether the desktop app is signed in to fabplane.com. */
  authState(): Promise<FabdeskAuthState> {
    return this.request("GET", "/v1/auth/state");
  }
}
