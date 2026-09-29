import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { commandTable } from "../src/index.js";

const root = (() => {
  let d = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(d, "package.json"))) d = dirname(d);
  return d;
})();
const integrations = join(root, "integrations");

type Skill = { platform: string; name: string; dir: string; text: string };
const skills: Skill[] = readdirSync(integrations, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((platform) =>
    readdirSync(join(integrations, platform.name), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(integrations, platform.name, d.name, "SKILL.md")))
      .map((d) => ({ platform: platform.name, name: d.name, dir: join(integrations, platform.name, d.name), text: readFileSync(join(integrations, platform.name, d.name, "SKILL.md"), "utf8") })),
  );

/** Top-level `key: value` pairs of the YAML frontmatter (nested blocks are kept as raw text). */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "SKILL.md starts with a --- frontmatter block");
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** Every `fabplane …` invocation in fenced code blocks and inline code spans. */
function fabplaneCommands(text: string): string[] {
  const out: string[] = [];
  for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const joined = block[1]!.replace(/\\\n\s*/g, " ");
    for (const line of joined.split(/\n|\|\||&&|;/)) {
      const idx = line.indexOf("fabplane ");
      if (idx >= 0 && /^\s*(?:[\w$()"'-]+=\S+\s+)*$/.test(line.slice(0, idx).replace(/^\s*(?:\|\||&&|if|then|else|do)?\s*/, "")) ) out.push(line.slice(idx).replace(/\s+#.*$/, ""));
    }
  }
  for (const span of text.replace(/```[\s\S]*?```/g, "").matchAll(/`(fabplane [^`]+)`/g)) out.push(span[1]!);
  return out;
}

const table = commandTable();

function checkCommand(line: string): string | null {
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
}

describe("integration skills", () => {
  it("ship an openclaw and a hermes skill", () => {
    assert.deepEqual(skills.map((s) => `${s.platform}/${s.name}`).sort(), ["hermes/fabplane-inventory", "openclaw/fabplane-inventory"]);
    for (const p of ["openclaw", "hermes"]) assert.ok(existsSync(join(integrations, p, "README.md")), `${p} README`);
  });

  for (const skill of skills) {
    describe(`${skill.platform}/${skill.name}`, () => {
      it("has valid frontmatter for its platform", () => {
        const fm = frontmatter(skill.text);
        assert.equal(fm["name"], skill.name, "name matches the folder");
        assert.ok(fm["description"] && fm["description"].length > 10, "description");
        if (skill.platform === "openclaw") {
          assert.match(fm["user-invocable"] ?? "", /^(true|false)$/);
          assert.ok(fm["argument-hint"], "argument-hint");
        }
        if (skill.platform === "hermes") {
          assert.match(fm["version"] ?? "", /^\d+\.\d+\.\d+$/);
          assert.ok(fm["description"]!.length <= 60, "Hermes recommends descriptions under 60 characters");
          assert.match(skill.text, /\n {2}hermes:\n/, "metadata.hermes block");
        }
      });

      it("only uses real fabplane commands and flags", () => {
        const cmds = fabplaneCommands(skill.text);
        assert.ok(cmds.length >= 10, `found ${cmds.length} commands`);
        const problems = cmds.map(checkCommand).filter((p): p is string => p !== null);
        assert.deepEqual(problems, []);
        for (const needed of ["inventory list", "inventory add", "inventory photos claim", "inventory photos attach", "inventory photos skip", "carts add"]) {
          assert.ok(cmds.some((c) => c.startsWith(`fabplane ${needed}`)), `mentions fabplane ${needed}`);
        }
        assert.ok(!cmds.some((c) => c.includes("--server-ai")), "never runs --server-ai");
      });

      it("stays generic (no hosts, emails or private paths)", () => {
        assert.doesNotMatch(skill.text, /https?:\/\//);
        assert.doesNotMatch(skill.text, /[\w.-]+@[\w-]+\.[\w.]+/);
        assert.doesNotMatch(skill.text, /\/home\/|\/Users\/|C:\\\\/);
      });
    });
  }

  it("the integration READMEs only use real fabplane commands", () => {
    for (const p of ["openclaw", "hermes"]) {
      const text = readFileSync(join(integrations, p, "README.md"), "utf8");
      const problems = fabplaneCommands(text).map(checkCommand).filter((x): x is string => x !== null);
      assert.deepEqual(problems, [], p);
      assert.match(text, /fabplane bot connect --agent/);
    }
  });

  it("the main README only uses real fabplane commands", () => {
    const text = readFileSync(join(root, "README.md"), "utf8");
    const cmds = fabplaneCommands(text);
    assert.ok(cmds.length > 20);
    assert.deepEqual(cmds.map(checkCommand).filter((x): x is string => x !== null), []);
  });

  it("the checker rejects unknown commands and flags", () => {
    assert.match(checkCommand("fabplane inventory frobnicate") ?? "", /unknown command/);
    assert.match(checkCommand("fabplane inventory add --name x --bogus") ?? "", /unknown flag --bogus/);
    assert.equal(checkCommand('fabplane inventory photos attach <id> --url <u> --source-url "p"'), null);
  });
});
