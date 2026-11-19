import { rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const test = process.argv.includes('--test');
rmSync(test ? 'build-test' : 'dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', test ? 'tsconfig.test.json' : 'tsconfig.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!test) chmodSync('dist/cli.js', 0o755);
