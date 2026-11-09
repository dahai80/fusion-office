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

// Issue #23: the baked key rides in every standalone bundle, extractable by
// anyone who downloads it. The admin key (also web_shell.admin_key) is
// unlimited (rpm/tpm 0), so baking it hands out the master credential —
// refuse the build rather than ship it. Standalone builds bake a dedicated
// low-privilege key instead; inside the union shell no key is needed at all.
if (process.env.VITE_FUSION_GATEWAY_KEY && process.env.VITE_FUSION_GATEWAY_KEY === process.env.FUSION_ADMIN_KEY) {
    console.error('[build] refusing to bake the gateway admin key (FUSION_ADMIN_KEY) as VITE_FUSION_GATEWAY_KEY: the standalone bundle is public to anyone who downloads it. Use a dedicated low-privilege gateway key with explicit rpm/tpm caps.');
    process.exit(1);
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
