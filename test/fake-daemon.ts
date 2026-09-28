/** A fake fabdesk-core daemon: the loopback HTTP routes FabdeskClient uses. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const DAEMON_TOKEN = "daemon-token-0123456789abcdef";

export async function startFakeDaemon(): Promise<{ port: number; url: string; requests: Array<{ method: string; url: string; auth: string | null; body: unknown }>; close(): Promise<void> }> {
  const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ method: req.method ?? "GET", url: url.pathname + url.search, auth: req.headers.authorization ?? null, body });
    const send = (status: number, value: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof value === "string" ? value : JSON.stringify(value));
    };
    if (url.pathname === "/health") return send(200, { ok: true, version: "9.9.9", pid: 42, channel: "public", authMode: "local" });
    if (req.headers.authorization !== `Bearer ${DAEMON_TOKEN}`) return send(401, { error: "unauthorized" });
    const p = url.pathname;
    if (p === "/projects" && req.method === "GET") return send(200, [{ id: "p1", name: "Blinky", updatedAt: "2026-01-01" }]);
    if (p === "/projects" && req.method === "POST") return send(201, { id: "p2", name: body.name });
    if (p === "/projects/p1") return send(200, { id: "p1", name: "Blinky" });
    if (p === "/projects/p1/files/docs/readme.md") return send(200, "# Blinky", "text/markdown");
    if (p === "/threads" && req.method === "GET") return send(200, [{ id: "t1", title: "Chat", q: url.searchParams.get("q") }]);
    if (p === "/threads" && req.method === "POST") return send(201, { id: "t2", ...body });
    if (p === "/threads/t1") return send(200, { id: "t1", title: "Chat" });
    if (p === "/threads/t1/messages" && req.method === "GET") return send(200, [{ id: "m1" }]);
    if (p === "/threads/t1/messages" && req.method === "POST") return send(202, { runId: "r1", messageId: "m2", userMessageId: "m1" });
    if (p === "/runs/live") return send(200, [{ runId: "r1", threadId: "t1", agentId: "claude", startedAt: "now" }]);
    if (p === "/tools/manifest") return send(200, [{ name: "board_stats", toolset: "kicad", title: "Board stats", description: "d", inputSchema: {}, annotations: { readOnlyHint: true }, longRunning: false }]);
    if (p === "/tools/board_stats") return send(200, { ok: true, text: "2 layers", json: { layers: 2 } });
    if (p === "/tools/route_run") return url.searchParams.get("sync") === "1" ? send(200, { ok: true, text: "routed" }) : send(202, { jobId: "j1" });
    if (p === "/tools/verify_drc") return send(422, { ok: false, text: "3 violations" });
    if (p.startsWith("/tools/")) return send(404, { error: "unknown tool" });
    if (p === "/jobs") return send(200, [{ id: "j1", status: "done" }]);
    if (p === "/jobs/j1") return send(200, { id: "j1", kind: "tool:route_run", projectId: "p1", status: "done", progress: 1, note: null, result: {}, error: null, startedAt: null, endedAt: null });
    if (p === "/settings") return send(200, { theme: "dark" });
    if (p === "/v1/auth/state") return send(200, { mode: "fabplane", status: "signed_in", principal: { subject: "s", handle: "maya" } });
    return send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}
