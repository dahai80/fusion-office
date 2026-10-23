import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = ['documents', 'spreadsheet', 'presentation', 'pdf', 'pm'];
let failed = 0;

for (const app of apps) {
    const started = Date.now();
    console.log(`[build] ${app}`);
    const result = spawnSync('npm', ['run', 'build'], {
        cwd: join(root, 'apps', app),
        stdio: 'inherit',
        env: process.env,
    });
    const ms = Date.now() - started;
    if (result.status !== 0) {
        failed += 1;
        console.error(`[build] ${app} failed after ${ms}ms`);
    } else {
        console.log(`[build] ${app} ok in ${ms}ms`);
    }
}

if (failed) {
    console.error(`[build] ${failed} app(s) failed`);
    process.exit(1);
}
console.log('[build] all apps built');
