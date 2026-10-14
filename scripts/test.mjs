import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('build-test/test').filter(f => f.endsWith('.test.js')).map(f => `build-test/test/${f}`);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
