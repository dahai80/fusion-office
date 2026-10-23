import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = ['documents', 'spreadsheet', 'presentation', 'pdf', 'pm'];
const gateway = process.env.FUSION_GATEWAY_URL || 'http://127.0.0.1:11432';
const adminKey = process.env.FUSION_GATEWAY_ADMIN_KEY;
const masterKey = process.env.FUSION_GATEWAY_MASTER_KEY;
const smoke = process.argv.includes('--smoke');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
    '.traineddata': 'application/octet-stream',
    '.gz': 'application/gzip',
};

function log(message, ...args) {
    console.log('[shell-serve]', message, ...args);
}

async function fileAt(dist, pathname) {
    const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let target = join(dist, clean);
    try {
        const info = await stat(target);
        if (info.isDirectory()) target = join(target, 'index.html');
        return { target, info: await stat(target) };
    } catch (error) {
        if (extname(clean)) return null;
        const fallback = join(dist, 'index.html');
        try {
            return { target: fallback, info: await stat(fallback) };
        } catch {
            return null;
        }
    }
}

function serve(dist) {
    return new Promise((resolve) => {
        const server = createServer(async (req, res) => {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            const found = await fileAt(dist, pathname === '/' ? '/index.html' : pathname);
            if (!found) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('not found');
                return;
            }
            try {
                const body = await readFile(found.target);
                res.writeHead(200, {
                    'Content-Type': MIME[extname(found.target)] || 'application/octet-stream',
                    'Cache-Control': 'no-cache',
                });
                res.end(body);
            } catch (error) {
                console.error('[shell-serve] read failed', found.target, error.message);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('read failed');
            }
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function api(path, init = {}) {
    const res = await fetch(gateway + path, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminKey}`,
            ...(init.headers || {}),
        },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

async function register(manifest, upstream) {
    const body = { ...manifest, upstream };
    await api('/api/v1/shell/manifests', { method: 'POST', body: JSON.stringify(body) });
    log('registered', manifest.id, '->', upstream);
}

async function unregister(id) {
    try {
        await api(`/api/v1/shell/manifests/${id}`, { method: 'DELETE' });
        log('unregistered', id);
    } catch (error) {
        log('unregister skipped', id, error.message);
    }
}

function mintSession() {
    const secret = createHash('sha256').update(`${masterKey}:shell-session-v1`).digest('hex');
    const claims = {
        sub: 'shell-smoke',
        roles: ['admin'],
        permissions: ['*'],
        tenant_id: 'local',
        exp: Math.floor(Date.now() / 1000) + 600,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createHmac('sha256', secret).update(encoded).digest('hex');
    return `${encoded}.${sig}`;
}

async function smokeOne(manifest, token) {
    const url = `${gateway}/shell/${manifest.id}/`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const html = await res.text();
    if (!res.ok) throw new Error(`${url} -> ${res.status}: ${html.slice(0, 200)}`);
    if (!/<div id="app"/i.test(html)) throw new Error(`${url} returned no app root`);
    const asset = html.match(/(?:src|href)="\.\/(assets\/[^"]+)"/);
    if (asset) {
        const assetUrl = `${gateway}/shell/${manifest.id}/${asset[1]}`;
        const assetRes = await fetch(assetUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!assetRes.ok) throw new Error(`${assetUrl} -> ${assetRes.status}`);
        await assetRes.arrayBuffer();
    }
    log('smoke ok', manifest.id, `html ${html.length}B`, asset ? `asset ${asset[1]}` : 'no asset');
}

async function main() {
    if (!adminKey) {
        console.error('[shell-serve] FUSION_GATEWAY_ADMIN_KEY is required');
        process.exit(1);
    }
    if (smoke && !masterKey) {
        console.error('[shell-serve] FUSION_GATEWAY_MASTER_KEY is required for --smoke');
        process.exit(1);
    }
    const started = [];
    let stopping = false;

    async function stop() {
        if (stopping) return;
        stopping = true;
        for (const entry of started) await unregister(entry.manifest.id);
        for (const entry of started) entry.server.close();
        process.exit(0);
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    for (const app of apps) {
        const dist = join(root, 'apps', app, 'dist');
        const manifestPath = join(root, 'apps', app, 'web', 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        try {
            await stat(join(dist, 'index.html'));
        } catch {
            console.error(`[shell-serve] ${app} has no dist; run npm run build first`);
            await stop();
            return;
        }
        const server = await serve(dist);
        const port = server.address().port;
        started.push({ app, manifest, server });
        await register(manifest, `http://127.0.0.1:${port}`);
        log('serving', app, `http://127.0.0.1:${port}`, `via /shell/${manifest.id}/`);
    }

    if (smoke) {
        const token = mintSession();
        let failed = 0;
        for (const entry of started) {
            try {
                await smokeOne(entry.manifest, token);
            } catch (error) {
                failed += 1;
                console.error('[shell-serve] smoke failed', entry.manifest.id, error.message);
            }
        }
        for (const entry of started) await unregister(entry.manifest.id);
        for (const entry of started) entry.server.close();
        if (failed) {
            console.error(`[shell-serve] smoke: ${failed} module(s) failed`);
            process.exit(1);
        }
        log('smoke: all modules pass');
        process.exit(0);
    }

    setInterval(async () => {
        for (const entry of started) {
            try {
                await api(`/api/v1/shell/manifests/${entry.manifest.id}/heartbeat`, { method: 'POST' });
            } catch (error) {
                console.error('[shell-serve] heartbeat failed', entry.manifest.id, error.message);
            }
        }
    }, 20000).unref();

    log('ready:', started.map((entry) => `${gateway}/shell/${entry.manifest.id}/`).join(' '));
}

main().catch((error) => {
    console.error('[shell-serve] failed', error);
    process.exit(1);
});
