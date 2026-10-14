// Exercise the public tarball, without source checkout resolution or user credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'fabplane-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run with npm run test:package');
const env = { ...process.env, FABPLANE_CREDENTIALS_FILE: join(temp, 'credentials.json'), FABPLANE_API_ORIGIN: 'http://127.0.0.1:1', FABPLANE_NO_BROWSER: '1' };
delete env.FABPLANE_TOKEN;
function run(args, cwd = temp) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
try {
  const [pack] = JSON.parse(run([npm, 'pack', '--json', '--pack-destination', temp], root));
  const files = pack.files.map(f => f.path);
  for (const file of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'src/index.ts', 'LICENSE', 'README.md']) assert.ok(files.includes(file), file);
  assert.ok(files.every(f => !f.endsWith('.map') && !f.startsWith('test/')), 'Unexpected public contents');
  writeFileSync(join(temp, 'package.json'), '{"private":true,"type":"module"}');
  run([npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', resolve(temp, pack.filename)]);
  const installed = join(temp, 'node_modules/fabplane-cli');
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  assert.equal(run([join(installed, 'dist/cli.js'), '--version']), version);
  assert.match(run([join(installed, 'dist/cli.js'), 'help']), /fabplane/);
  assert.equal(run(['--input-type=module', '-e', 'import { VERSION, FabplaneClient, createFabplaneMcpServer } from "fabplane-cli"; if (!FabplaneClient || !createFabplaneMcpServer) process.exit(1); console.log(VERSION)']), version);
  // Every export condition must point at a file actually in the tarball (including Bun).
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json')));
  for (const target of Object.values(pkg.exports['.'])) assert.ok(files.includes(target.replace(/^\.\//, '')), target);
  // npm creates the executable shim/symlink from the declared bin.
  run([npm, 'exec', '--offline', '--', 'fabplane', '--version']);
  console.log(`Packed installation passed: ${pack.filename}, ${files.length} files, ${pack.unpackedSize} bytes`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
