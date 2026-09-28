#!/usr/bin/env node
/** `fabplane` bin entry: wires `runCli` to the real process. */
import { spawn } from "node:child_process";
import { runCli } from "./cli/run.js";

function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const interactive = Boolean(process.stdout.isTTY && process.stderr.isTTY);

runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
  readStdin,
  isTTY: interactive,
  ...(interactive && !process.env["FABPLANE_NO_BROWSER"] ? { openUrl } : {}),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
