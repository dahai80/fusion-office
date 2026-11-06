import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = ['documents', 'spreadsheet', 'presentation', 'pdf', 'pm'];
let failed = 0;

// Vite resolves env files from each app's own directory, so a root
// .env.local would never be seen; feed it into the environment instead.
// Values already in the environment win. The file is gitignored and holds
// build-time defaults such as VITE_FUSION_GATEWAY_KEY.
try {
    for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].trim();
    }
} catch (err) {
    // No .env.local: builds run without baked defaults.
}

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

// Issue #12: precompress large dist assets so shell-serve can serve .gz
// siblings without per-request work. Failures warn but do not fail the build.
const { execFileSync } = await import('node:child_process');
for (const app of apps) {
    try {
        const out = execFileSync('node', [join(root, 'scripts', 'gzip-dist.mjs'), join(root, 'apps', app, 'dist')], { encoding: 'utf8' });
        console.log(out.trim());
    } catch (err) {
        console.error(`[gzip-dist] ${app} failed: ${err.message}`);
    }
}
