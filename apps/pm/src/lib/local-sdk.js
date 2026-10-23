import * as S from '@fusion-office/storage';

const LOCAL_USER = { username: 'local', uuid: 'local', name: 'Local User' };
const IMPORT_DIR = 'Projects/Imported';

function missing(path) {
  return Object.assign(new Error(`No such file: ${path}`), {
    code: 'subject_does_not_exist',
  });
}

function isMissing(error) {
  const code = error?.code ?? error?.error?.code;
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '').toLowerCase();
  return (
    name === 'NotFoundError' ||
    code === 'subject_does_not_exist' ||
    code === 'ENOENT' ||
    message.includes('not found') ||
    message.includes('could not be found') ||
    message.includes('no such')
  );
}

function toEntry(entry) {
  return {
    name: entry.name,
    path: entry.path,
    is_dir: entry.kind === 'directory',
    size: entry.size ?? 0,
    modified: entry.mtime ?? null,
  };
}

async function freePath(name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = `${IMPORT_DIR}/${name}`;
  for (let n = 2; await S.stat(candidate); n++) {
    candidate = `${IMPORT_DIR}/${stem} ${n}${ext}`;
  }
  return candidate;
}

async function importPicked(picked) {
  const file = picked?.file;
  if (!file) return null;
  const path = await freePath(file.name || `file-${Date.now()}`);
  await S.writeFile(path, file);
  S.log('pm-sdk', 'imported', file.name, '->', path);
  return {
    path,
    name: path.split('/').pop(),
    size: file.size,
    type: file.type || '',
  };
}

export function createLocalPuter() {
  const ui = {};
  if (typeof globalThis.showOpenFilePicker === 'function') {
    ui.showOpenFilePicker = async () => {
      try {
        const picked = await S.pickOpenFile([]);
        const item = await importPicked(picked);
        return item ? [item] : null;
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw error;
      }
    };
  }
  if (typeof globalThis.showSaveFilePicker === 'function') {
    ui.showSaveFilePicker = async (data, suggestedName) => {
      let picked;
      try {
        picked = await S.pickSaveFile(suggestedName, []);
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw error;
      }
      if (!picked?.handle) return null;
      const blob = data instanceof Blob ? data : new Blob([data]);
      const writable = await picked.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      S.log('pm-sdk', 'saved as', suggestedName, blob.size);
      return {
        path: suggestedName,
        name: suggestedName,
        size: blob.size,
        type: blob.type,
      };
    };
  }
  return {
    env: 'app',
    auth: {
      isSignedIn: () => true,
      getUser: async () => LOCAL_USER,
      signIn: async () => LOCAL_USER,
      signOut: async () => {},
    },
    kv: {
      get: (key) => S.get(key),
      set: (key, value) => S.set(key, value),
      del: (key) => S.del(key),
    },
    fs: {
      async write(path, data) {
        const blob =
          data instanceof Blob
            ? data
            : new Blob([data], {
                type: typeof data === 'string' ? 'application/json' : '',
              });
        await S.writeFile(path, blob);
        const info = await S.stat(path).catch(() => null);
        return {
          path,
          size: info?.size ?? blob.size,
          modified: info?.mtime ?? Date.now(),
        };
      },
      async read(path) {
        try {
          return await S.readFile(path);
        } catch (error) {
          if (isMissing(error)) throw missing(path);
          throw error;
        }
      },
      async readdir(dir) {
        try {
          const entries = await S.readdir(dir);
          return entries.map(toEntry);
        } catch (error) {
          if (isMissing(error)) throw missing(dir);
          throw error;
        }
      },
      async stat(path) {
        const info = await S.stat(path).catch((error) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (!info) throw missing(path);
        return {
          path,
          name: info.name,
          size: info.size ?? 0,
          modified: info.mtime ?? null,
        };
      },
      async delete(path) {
        try {
          await S.deleteFile(path);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      },
      async rename(from, to) {
        await S.rename(from, to);
        const info = await S.stat(to).catch(() => null);
        return { path: to, size: info?.size ?? 0, modified: info?.mtime ?? null };
      },
    },
    ui,
  };
}

export function installLocalSdk() {
  if (typeof globalThis.puter !== 'undefined') return globalThis.puter;
  globalThis.puter = createLocalPuter();
  S.log('pm-sdk', 'local SDK installed');
  return globalThis.puter;
}
