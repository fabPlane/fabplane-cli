import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FabdeskClient, FabdeskError, appDataDir, daemonFileCandidates, fabdeskHome, findDaemonHandshake } from "../src/index.js";
import { DAEMON_TOKEN, startFakeDaemon } from "./fake-daemon.js";

describe("fabdesk home + daemon.json discovery", () => {
  it("resolves per-platform dirs", () => {
    assert.equal(appDataDir({ HOME: "/h" }, "darwin"), join("/h", "Library", "Application Support"));
    assert.equal(appDataDir({ HOME: "/h", APPDATA: "C:\\R" }, "win32"), "C:\\R");
    assert.equal(appDataDir({ HOME: "/h" }, "linux"), join("/h", ".config"));
    assert.equal(appDataDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux"), "/x");
    assert.equal(fabdeskHome({ HOME: "/h" }, "darwin"), join("/h", "Library", "Application Support", "fabdesk"));
    assert.equal(fabdeskHome({ FABDESK_HOME: "/fh" }, "linux"), "/fh");
  });

  it("lists the desktop app and daemon locations, FABDESK_HOME first", () => {
    const c = daemonFileCandidates({ HOME: "/h", FABDESK_HOME: "/fh" }, "darwin");
    const base = join("/h", "Library", "Application Support");
    assert.deepEqual(c, [join("/fh", "daemon.json"), join(base, "fabPlane", "daemon.json"), join(base, "fabdesk", "daemon.json"), join(base, "fabPlane Dev", "daemon.json"), join(base, "fabdesk-dev", "daemon.json")]);
    assert.deepEqual(daemonFileCandidates({ FABDESK_DAEMON_FILE: "/d.json" }, "linux"), ["/d.json"]);
  });

  it("prefers a live daemon over a stale file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-"));
    const stale = join(dir, "stale.json");
    const live = join(dir, "live.json");
    await writeFile(stale, JSON.stringify({ version: "1", pid: 999999, port: 1, host: "127.0.0.1", token: "x".repeat(20), startedAt: "2030-01-01" }));
    await writeFile(live, JSON.stringify({ version: "2", pid: process.pid, port: 2, token: "y".repeat(20), startedAt: "2020-01-01" }));
    const hs = await findDaemonHandshake({ candidates: [join(dir, "missing.json"), stale, live] });
    assert.equal(hs?.port, 2);
    assert.equal(hs?.host, "127.0.0.1");
    assert.equal(hs?.alive, true);
    const onlyStale = await findDaemonHandshake({ candidates: [stale] });
    assert.equal(onlyStale?.alive, false);
    assert.equal(await findDaemonHandshake({ candidates: [join(dir, "missing.json")] }), null);
  });
});

describe("FabdeskClient against a fake daemon", () => {
  let daemon: Awaited<ReturnType<typeof startFakeDaemon>>;
  let desk: FabdeskClient;
  before(async () => {
    daemon = await startFakeDaemon();
    const home = await mkdtemp(join(tmpdir(), "fabdesk-home-"));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "daemon.json"), JSON.stringify({ version: "9.9.9", pid: process.pid, port: daemon.port, host: "127.0.0.1", token: DAEMON_TOKEN, startedAt: new Date().toISOString(), channel: "public", authMode: "local" }));
    desk = new FabdeskClient({ env: { FABDESK_HOME: home, HOME: home } });
  });
  after(() => daemon.close());

  it("reads daemon.json and calls the API with the bearer token", async () => {
    assert.equal((await desk.health()).version, "9.9.9");
    assert.equal(daemon.requests.at(-1)?.auth, null, "health is unauthenticated");
    assert.deepEqual((await desk.projects()).map((p) => p.name), ["Blinky"]);
    assert.equal(daemon.requests.at(-1)?.auth, `Bearer ${DAEMON_TOKEN}`);
    assert.equal((await desk.connection()).baseUrl, daemon.url);
  });

  it("covers projects, files, threads, runs, jobs, settings and auth", async () => {
    assert.equal((await desk.project("p1")).name, "Blinky");
    assert.equal((await desk.createProject("New")).name, "New");
    assert.equal(await desk.readFile("p1", "/docs/readme.md"), "# Blinky");
    assert.equal((await desk.threads({ q: "hi" }))[0]?.["q"], "hi");
    assert.equal((await desk.thread("t1")).id, "t1");
    assert.equal((await desk.createThread({ agentId: "claude", projectId: "p1" })).id, "t2");
    assert.deepEqual(daemon.requests.at(-1)?.body, { agentId: "claude", projectId: "p1" });
    assert.equal((await desk.messages("t1")).length, 1);
    assert.equal((await desk.sendMessage("t1", "route it")).runId, "r1");
    assert.deepEqual(daemon.requests.at(-1)?.body, { content: "route it" });
    assert.equal((await desk.liveRuns())[0]?.runId, "r1");
    assert.equal((await desk.jobs()).length, 1);
    assert.equal((await desk.waitJob("j1")).status, "done");
    assert.equal((await desk.settings())["theme"], "dark");
    assert.equal((await desk.authState()).status, "signed_in");
  });

  it("toolManifest and callTool (sync, queued, isError)", async () => {
    assert.equal((await desk.toolManifest())[0]?.name, "board_stats");
    const r = await desk.callTool("board_stats", { verbose: true }, { projectId: "p1" });
    assert.equal(r.text, "2 layers");
    assert.deepEqual(daemon.requests.at(-1)?.body, { args: { verbose: true }, project: "p1" });
    assert.deepEqual(await desk.callTool("route_run", {}, { projectId: "p1" }), { jobId: "j1" });
    await desk.callTool("route_run", {}, { projectId: "p1", sync: true });
    assert.equal(daemon.requests.at(-1)?.url, "/tools/route_run?sync=1");
    const failed = await desk.callTool("verify_drc");
    assert.equal(failed.ok, false);
    await assert.rejects(desk.callTool("nope"), (e: unknown) => e instanceof FabdeskError && e.status === 404);
  });

  it("FABDESK_URL + FABDESK_TOKEN skip discovery", async () => {
    const d = new FabdeskClient({ env: { FABDESK_URL: `${daemon.url}/`, FABDESK_TOKEN: DAEMON_TOKEN, FABDESK_DAEMON_FILE: "/nonexistent" } });
    assert.equal((await d.projects()).length, 1);
  });

  it("explains when fabdesk is not running", async () => {
    const d = new FabdeskClient({ env: { FABDESK_DAEMON_FILE: join(tmpdir(), "no-such-daemon.json") } });
    await assert.rejects(d.projects(), /fabdesk is not running/);
  });
});
