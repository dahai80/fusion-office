// Issue #12: the bundled fonts ship as WOFF2; the TTF originals stay in
// public/ for the font-metrics tests and provenance hashes but must not
// reach dist, where they would double the fonts payload for nothing.
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export default function stripTtfDist() {
    return {
        name: 'strip-ttf-dist',
        closeBundle() {
            let removed = 0;
            const walk = dir => {
                for (const entry of readdirSync(dir)) {
                    const path = join(dir, entry);
                    if (statSync(path).isDirectory()) walk(path);
                    else if (entry.endsWith('.ttf')) {
                        rmSync(path);
                        removed += 1;
                    }
                }
            };
            try {
                walk('dist');
            } catch (err) {
                console.error('[strip-ttf-dist] failed to walk dist:', err.message);
            }
            if (removed) console.log(`[strip-ttf-dist] removed ${removed} ttf files from dist`);
        },
    };
}
