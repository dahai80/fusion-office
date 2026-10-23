import { readdir, readFile, mkdir, lstat, symlink, access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.log('[link-test-node-modules]', ...args);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function testFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

const REFERENCE = /\.\.\/node_modules\/((?:@[^/\s'")]+\/)?[^/\s'")]+)/g;

async function packagesReferenced(files) {
  const names = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(REFERENCE)) names.add(match[1]);
  }
  return names;
}

async function link(appDir, name) {
  const target = join(root, 'node_modules', name);
  if (!(await exists(join(target, 'package.json')))) {
    log(`skip ${relative(root, appDir)}: ${name} is not installed at the workspace root`);
    return false;
  }
  const appModules = join(appDir, 'node_modules');
  const linkPath = join(appModules, name);
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    await lstat(linkPath);
    return false;
  } catch {
    // Missing: fall through and create it.
  }
  await symlink(relative(dirname(linkPath), target), linkPath, 'junction');
  log(`linked ${relative(root, linkPath)} -> ${relative(dirname(linkPath), target)}`);
  return true;
}

async function main() {
  const appsDir = join(root, 'apps');
  const apps = await readdir(appsDir, { withFileTypes: true });
  let linked = 0;
  for (const app of apps) {
    if (!app.isDirectory()) continue;
    const appDir = join(appsDir, app.name);
    const files = await testFiles(join(appDir, 'tests'));
    if (!files.length) continue;
    for (const name of await packagesReferenced(files)) {
      if (await link(appDir, name)) linked += 1;
    }
  }
  log(`done, ${linked} link(s) created`);
}

main().catch((error) => {
  console.error('[link-test-node-modules] failed:', error);
  process.exitCode = 1;
});
