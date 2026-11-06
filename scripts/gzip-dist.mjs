// Issue #12: emit a .gz sibling for every compressible dist file over 1 KB
// so shell-serve (and any front proxy) can serve precompressed bytes.
// Already-compressed formats (woff2, images, wasm, zip) are skipped.
import { gzipSync } from 'node:zlib';
import { readdirSync, statSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.xml', '.dic', '.aff', '.map', '.wasm']);
const SKIP = new Set(['.woff2', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.gz', '.br']);
const MIN_BYTES = 1024;

const roots = process.argv.slice(2);
if (!roots.length) {
    console.error('usage: node scripts/gzip-dist.mjs <dist-dir>...');
    process.exit(1);
}

let emitted = 0;
let saved = 0;
const walk = dir => {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            walk(path);
            continue;
        }
        const ext = extname(entry).toLowerCase();
        if (SKIP.has(ext) || !COMPRESSIBLE.has(ext)) continue;
        const raw = statSync(path).size;
        if (raw < MIN_BYTES) continue;
        const gz = path + '.gz';
        if (existsSync(gz)) rmSync(gz);
        const out = gzipSync(readFileSync(path), { level: 9 });
        writeFileSync(gz, out);
        emitted += 1;
        saved += raw - out.length;
    }
};

for (const root of roots) {
    try {
        walk(root);
    } catch (err) {
        console.error(`[gzip-dist] ${root}: ${err.message}`);
        process.exitCode = 1;
    }
}
console.log(`[gzip-dist] emitted ${emitted} .gz files, ${(saved / 1048576).toFixed(1)} MB saved`);
