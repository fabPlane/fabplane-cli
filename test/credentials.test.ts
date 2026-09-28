import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CredentialStore, FabplaneClient, configDir, credentialsPath, resolveAuth, resolveDefaultOrg } from "../src/index.js";

const tmp = () => mkdtemp(join(tmpdir(), "fabplane-cred-"));

describe("config paths", () => {
  it("uses XDG_CONFIG_HOME, ~/.config, or %APPDATA%", () => {
    assert.equal(configDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux"), join("/x", "fabplane"));
    assert.equal(configDir({ HOME: "/h" }, "darwin"), join("/h", ".config", "fabplane"));
    assert.equal(configDir({ HOME: "/h", APPDATA: "C:\\AppData" }, "win32"), join("C:\\AppData", "fabplane"));
    assert.equal(credentialsPath({ HOME: "/h" }, "linux"), join("/h", ".config", "fabplane", "credentials.json"));
    assert.equal(credentialsPath({ FABPLANE_CREDENTIALS_FILE: "/c.json" }, "linux"), "/c.json");
  });
});

describe("CredentialStore", () => {
  it("writes atomically with mode 0600 and merges profiles per origin", async () => {
    const dir = await tmp();
    const store = new CredentialStore({ path: join(dir, "nested", "credentials.json") });
    assert.deepEqual(await store.read(), { version: 1, profiles: {} });
    await store.saveProfile("https://api.example.test/", { token: "fpk_one", tokenKind: "api" });
    await store.saveProfile("http://localhost:4000", { token: "fpd_two" });
    await store.saveProfile("https://api.example.test", { defaultOrgId: "org-1" });
    const file = await store.read();
    assert.equal(file.currentOrigin, "https://api.example.test");
    assert.equal(file.profiles["https://api.example.test"]?.token, "fpk_one");
    assert.equal(file.profiles["https://api.example.test"]?.defaultOrgId, "org-1");
    assert.equal(file.profiles["http://localhost:4000"]?.token, "fpd_two");
    if (process.platform !== "win32") {
      assert.equal((await stat(store.path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
    }
    assert.deepEqual(await readdir(join(dir, "nested")), ["credentials.json"], "no temp files left");
    assert.equal(await store.removeProfile("https://api.example.test"), true);
    assert.equal((await store.read()).currentOrigin, undefined);
    assert.equal(await store.removeProfile("https://api.example.test"), false);
  });

  it("refuses to save a profile without a token", async () => {
    const store = new CredentialStore({ path: join(await tmp(), "c.json") });
    await assert.rejects(store.saveProfile("https://x.test", { defaultOrgId: "o" }), /No token/);
  });

  it("treats a corrupt file as empty", async () => {
    const path = join(await tmp(), "c.json");
    await writeFile(path, "{nope");
    assert.deepEqual(await new CredentialStore({ path }).read(), { version: 1, profiles: {} });
  });
});

describe("resolveAuth", () => {
  it("env wins over the file; the file's current origin is the default", async () => {
    const path = join(await tmp(), "c.json");
    const store = new CredentialStore({ path });
    await store.saveProfile("http://localhost:4000", { token: "fpd_file", defaultOrgId: "org-file" });
    let r = await resolveAuth({ env: {}, store });
    assert.equal(r.origin, "http://localhost:4000");
    assert.equal(r.token, "fpd_file");
    assert.equal(r.tokenSource, "file");
    assert.equal(r.orgId, "org-file");
    r = await resolveAuth({ env: { FABPLANE_TOKEN: "fpk_env", FABPLANE_ORG: "acme" }, store });
    assert.equal(r.token, "fpk_env");
    assert.equal(r.tokenSource, "env");
    assert.equal(r.orgId, "acme");
    assert.equal(r.orgSource, "env");
    r = await resolveAuth({ env: { FABPLANE_API_ORIGIN: "https://api.fabplane.com" }, store });
    assert.equal(r.origin, "https://api.fabplane.com");
    assert.equal(r.token, undefined);
    r = await resolveAuth({ env: { FABPLANE_TOKEN: "fpk_env" }, store, token: "fpk_flag", origin: "https://other.test", org: "o" });
    assert.equal(r.token, "fpk_flag");
    assert.equal(r.origin, "https://other.test");
    assert.equal(r.orgSource, "flag");
  });

  it("ignores expired stored tokens", async () => {
    const store = new CredentialStore({ path: join(await tmp(), "c.json") });
    await store.saveProfile("https://x.test", { token: "fpd_old", expiresAt: "2000-01-01T00:00:00.000Z" });
    assert.equal((await resolveAuth({ env: {}, store })).token, undefined);
  });

  it("does not leak into the real home (file stays where configured)", async () => {
    const path = join(await tmp(), "c.json");
    await new CredentialStore({ path }).saveProfile("https://x.test", { token: "t" });
    assert.match(await readFile(path, "utf8"), /"t"/);
  });
});

describe("resolveDefaultOrg", () => {
  const orgs = [
    { id: "11111111-1111-4111-8111-111111111111", slug: "maya", name: "Maya", personal: true },
    { id: "22222222-2222-4222-8222-222222222222", slug: "acme", name: "Acme", personal: false },
  ];
  const client = () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ orgs }), { headers: { "content-type": "application/json" } });
    };
    return { client: new FabplaneClient({ token: "t", fetch }), calls: () => calls };
  };
  it("returns a UUID without a request", async () => {
    const c = client();
    assert.equal(await resolveDefaultOrg(c.client, { explicit: orgs[1]!.id, env: {} }), orgs[1]!.id);
    assert.equal(c.calls(), 0);
  });
  it("resolves a slug, FABPLANE_ORG, the stored default, then the personal org", async () => {
    assert.equal(await resolveDefaultOrg(client().client, { explicit: "acme", env: {} }), orgs[1]!.id);
    assert.equal(await resolveDefaultOrg(client().client, { env: { FABPLANE_ORG: "acme" } }), orgs[1]!.id);
    assert.equal(await resolveDefaultOrg(client().client, { env: {}, defaultOrgId: "acme" }), orgs[1]!.id);
    assert.equal(await resolveDefaultOrg(client().client, { env: {} }), orgs[0]!.id);
  });
  it("names the available orgs when a slug is unknown", async () => {
    await assert.rejects(resolveDefaultOrg(client().client, { explicit: "nope", env: {} }), /maya, acme/);
  });
});
