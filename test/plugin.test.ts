import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { commandTable, desktopTools, fabplaneTools } from "../src/index.js";

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "fabplane-cli") return dir;
    } catch {
      /* keep walking */
    }
    dir = dirname(dir);
  }
  throw new Error("package root not found");
}

const root = findRoot();
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), "utf8"));

const EXPECTED_CLOUD = fabplaneTools.map((t) => t.name);
const EXPECTED_DESKTOP = desktopTools.map((t) => t.name);

describe("marketplace plugin package", () => {
  it("plugin.json is an Agent Plugins 1.0.0 manifest pointing at this public repo", () => {
    const manifest = readJson("plugin.json") as {
      $schema: string;
      name: string;
      description: string;
      repository: string;
      license: string;
      author: { name: string };
    };
    assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    assert.equal(manifest.name, "fabplane");
    assert.equal(manifest.repository, "https://github.com/fabPlane/fabplane-cli");
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.author.name, "fabPlane");
    assert.match(manifest.description, /PCB/i);
    assert.doesNotMatch(JSON.stringify(manifest), /clone/i);
  });

  it("mcp.json and .mcp.json launch the published CLI MCP server", () => {
    for (const rel of ["mcp.json", ".mcp.json"]) {
      const mcp = readJson(rel) as {
        $schema: string;
        mcpServers: { fabplane: { type: string; command: string; args: string[] } };
      };
      assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
      const server = mcp.mcpServers.fabplane;
      assert.equal(server.type, "stdio");
      assert.equal(server.command, "npx");
      assert.deepEqual(server.args, ["-y", "fabplane-cli", "mcp", "--desktop"]);
    }
  });

  it("Cursor and Claude manifests stay aligned with the root plugin", () => {
    const cursor = readJson(".cursor-plugin/plugin.json") as {
      name: string;
      repository: string;
      logo: string;
      mcpServers: string;
    };
    const claude = readJson(".claude-plugin/plugin.json") as { name: string };
    assert.equal(cursor.name, "fabplane");
    assert.equal(cursor.repository, "https://github.com/fabPlane/fabplane-cli");
    assert.equal(cursor.logo, "assets/icon.svg");
    assert.equal(cursor.mcpServers, "./mcp.json");
    assert.equal(claude.name, "fabplane");
    assert.ok(existsSync(join(root, cursor.logo)));
    assert.ok(existsSync(join(root, "assets/icon.png")));
  });

  it("ships a square plated icon and an onboarding skill", () => {
    const svg = readFileSync(join(root, "assets/icon.svg"), "utf8");
    assert.match(svg, /viewBox="0 0 512 512"/);
    assert.match(svg, /width="512"/);
    assert.match(svg, /height="512"/);
    assert.match(svg, /#0d2a2a/);
    assert.match(svg, /#8dbc6c/);
    const skill = readFileSync(join(root, "skills/onboarding/SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: onboarding\n/m);
    assert.match(skill, /open my boards/i);
    assert.match(skill, /shopping list/i);
    assert.match(skill, /org_list/);
    assert.match(skill, /cart_list/);
    assert.match(skill, /desktop_projects/);
    assert.doesNotMatch(skill, /clone/i);
  });

  it("onboarding skill only uses real fabplane commands", () => {
    const table = commandTable();
    const check = (line: string): string | null => {
      const cleaned = line
        .replace(/"[^"]*"/g, "ARG")
        .replace(/<[^>]*>/g, "ARG")
        .replace(/\$\([^)]*\)/g, "ARG")
        .replace(/[[\]|]/g, " ");
      const tokens = cleaned.split(/\s+/).filter(Boolean).slice(1);
      let match: (typeof table)[number] | undefined;
      for (let n = 3; n >= 1 && !match; n--) match = table.find((c) => c.command === tokens.slice(0, n).join(" "));
      if (!match) return `unknown command: ${line}`;
      for (const t of tokens) {
        if (!t.startsWith("--")) continue;
        const flag = t.slice(2).split("=")[0]!;
        if (!match.options.includes(flag)) return `unknown flag --${flag} for "${match.command}": ${line}`;
      }
      return null;
    };
    const text = readFileSync(join(root, "skills/onboarding/SKILL.md"), "utf8");
    const cmds: string[] = [];
    for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      const joined = block[1]!.replace(/\\\n\s*/g, " ");
      for (const line of joined.split(/\n|\|\||&&|;/)) {
        const idx = line.indexOf("fabplane ");
        if (idx >= 0) cmds.push(line.slice(idx).replace(/\s+#.*$/, ""));
      }
    }
    for (const span of text.replace(/```[\s\S]*?```/g, "").matchAll(/`(fabplane [^`]+)`/g)) cmds.push(span[1]!);
    assert.ok(cmds.length >= 2, `found ${cmds.length} commands`);
    assert.deepEqual(cmds.map(check).filter((p): p is string => p !== null), []);
  });
});

describe("MCP stdio smoke (plugin entry)", () => {
  it("starts fabplane mcp --desktop and lists cloud + desktop tools", async () => {
    const built = join(root, "build-test/src/cli.js");
    const dist = join(root, "dist/cli.js");
    const entry = existsSync(built) ? built : dist;
    assert.ok(existsSync(entry), `built CLI missing (${built} or ${dist}); run npm test / npm run build`);

    const creds = join(mkdtempSync(join(tmpdir(), "fabplane-plugin-")), "credentials.json");
    const env: Record<string, string> = { FABPLANE_CREDENTIALS_FILE: creds };
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "FABPLANE_TOKEN" && key !== "FABPLANE_CREDENTIALS_FILE") env[key] = value;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp", "--desktop"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "plugin-test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      assert.deepEqual(names.slice().sort(), [...EXPECTED_CLOUD, ...EXPECTED_DESKTOP].sort());
    } finally {
      await client.close();
    }
  });
});
