import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = ['documents', 'spreadsheet', 'presentation', 'pdf', 'pm'];
const packages = ['packages/ai-client'];
let failed = 0;

for (const app of apps) {
    const started = Date.now();
    console.log(`[test] ${app}`);
    const result = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], {
        cwd: join(root, 'apps', app),
        stdio: 'inherit',
        env: process.env,
    });
    const ms = Date.now() - started;
    if (result.status !== 0) {
        failed += 1;
        console.error(`[test] ${app} failed after ${ms}ms`);
    } else {
        console.log(`[test] ${app} ok in ${ms}ms`);
    }
}

for (const pkg of packages) {
    const started = Date.now();
    console.log(`[test] ${pkg}`);
    const result = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], {
        cwd: join(root, pkg),
        stdio: 'inherit',
        env: process.env,
    });
    const ms = Date.now() - started;
    if (result.status !== 0) {
        failed += 1;
        console.error(`[test] ${pkg} failed after ${ms}ms`);
    } else {
        console.log(`[test] ${pkg} ok in ${ms}ms`);
    }
}

if (failed) {
    console.error(`[test] ${failed} app(s) failed`);
    process.exit(1);
}
console.log('[test] all apps pass');
