// Prepares the Node single-executable config for fusion-office: every dist
// file of the five apps plus each manifest becomes a SEA asset, and
// scripts/shell-serve.cjs is the entry. Pair with Node's native builder
// (node >= 26.7): node --build-sea sea-config.json — the postject injection
// path segfaults on current macOS and is not used. Run npm run build first.
import { readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(require.resolve('../package.json'), '..');
const apps = ['documents', 'spreadsheet', 'presentation', 'pdf', 'pm'];

async function walk(dir, into) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, into);
        else into.push(path);
    }
}

const assets = {};
for (const app of apps) {
    const dist = join(root, 'apps', app, 'dist');
    try {
        await stat(join(dist, 'index.html'));
    } catch {
        console.error(`[build-sea] ${app} has no dist; run npm run build first`);
        process.exit(1);
    }
    const files = [];
    await walk(dist, files);
    for (const file of files) {
        // SEA asset keys are repo-relative with forward slashes on every OS.
        assets[relative(root, file).split(sep).join('/')] = file;
    }
    assets[relative(root, join(root, 'apps', app, 'web', 'manifest.json')).split(sep).join('/')] =
        join(root, 'apps', app, 'web', 'manifest.json');
}

const config = {
    main: 'scripts/shell-serve.cjs',
    output: 'dist-sea/fusion-office',
    disableExperimentalSEAWarning: true,
    assets,
};
await writeFile(join(root, 'sea-config.json'), JSON.stringify(config, null, 4));
console.log(`[build-sea] ${Object.keys(assets).length} assets from ${apps.length} apps; run: node --build-sea sea-config.json (Node >= 26.7)`);
