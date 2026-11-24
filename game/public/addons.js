// The player's addons in a browser: the client's AddOns folder, which on the page is this store.
// Each file is kept in IndexedDB and read into memory before the client boots, so the client's
// synchronous reads (benilla_formats::host_fs) answer from `window.__wenilla_fs`. The Options
// screen's AddOns page installs (a .zip, picked by the player) and removes addons through
// `window.__rogue_addons`; what it installs loads at the next run.

const DB_NAME = 'azeroth-survivors-addons';
const STORE = 'files';
// The client's AddOns folder on the page: local_state's home plus `AddOns`.
const ROOT = '/benilla-config/addons';

// Lowercased path under the root -> { name: as written, data: Uint8Array }.
const files = new Map();
// Lowercased folder path ('' is the root) -> Map(lowercased child -> child as written).
const dirs = new Map([['', new Map()]]);

function index(name, data) {
  const parts = name.split('/');
  let at = '';
  for (let i = 0; i < parts.length; i++) {
    const lower = parts[i].toLowerCase();
    if (!dirs.has(at)) dirs.set(at, new Map());
    dirs.get(at).set(lower, parts[i]);
    at = at ? `${at}/${lower}` : lower;
    if (i < parts.length - 1 && !dirs.has(at)) dirs.set(at, new Map());
  }
  files.set(name.toLowerCase(), { name, data });
}

function reindex() {
  dirs.clear();
  dirs.set('', new Map());
  const all = [...files.values()];
  files.clear();
  for (const f of all) index(f.name, f.data);
}

// A client path under the AddOns root, lowercased and relative; null when it is not under it.
function rel(path) {
  const p = String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (p === ROOT) return '';
  return p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : null;
}

window.__wenilla_fs = {
  read(path) {
    const r = rel(path);
    return r === null ? undefined : files.get(r)?.data;
  },
  list(path) {
    const r = rel(path);
    const d = r === null ? undefined : dirs.get(r);
    return d ? [...d.values()] : [];
  },
  kind(path) {
    const r = rel(path);
    if (r === null) return undefined;
    if (files.has(r)) return 'file';
    return dirs.has(r) ? 'dir' : undefined;
  },
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, body) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = body(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

// ── Zip reading: stored and deflated entries, no zip64 (an addon is never 4 GB) ──

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const latin1 = new TextDecoder('latin1');
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('a damaged zip file');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const raw = u8.subarray(p + 46, p + 46 + nameLen);
    const name = ((flags & 0x800) ? utf8 : latin1).decode(raw).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const body = u8.subarray(start, start + size);
    if (method === 0) out.push({ name, data: body.slice() });
    else if (method === 8) out.push({ name, data: await inflate(body) });
    else throw new Error(`${name} is compressed in a way the browser cannot read`);
  }
  return out;
}

// The addons in a zip's entries: each folder holding a `.toc` named like it (or its only `.toc`,
// as in a `Name-master/Name.toc` download) is one addon, named by the `.toc`; a folder inside
// another addon's is part of that addon. Returns [{ name, files: [{ path under it, data }] }].
function addonsIn(entries) {
  const tocs = new Map(); // folder ('' for the zip's top) -> toc base names
  for (const e of entries) {
    const m = e.name.match(/^(?:(.*)\/)?([^/]+)\.toc$/i);
    if (!m) continue;
    const dir = m[1] || '';
    if (!tocs.has(dir)) tocs.set(dir, []);
    tocs.get(dir).push(m[2]);
  }
  const roots = [];
  for (const [dir, names] of tocs) {
    const base = dir.split('/').pop();
    const name = names.find((n) => n.toLowerCase() === base.toLowerCase())
      || (names.length === 1 ? names[0] : null);
    if (name) roots.push({ dir, name });
  }
  const top = roots.filter((r) => !roots.some((o) => o !== r
    && (o.dir === '' || r.dir.startsWith(`${o.dir}/`))));
  return top.map(({ dir, name }) => ({
    name,
    files: entries
      .filter((e) => dir === '' || e.name.startsWith(`${dir}/`))
      .map((e) => ({ path: dir === '' ? e.name : e.name.slice(dir.length + 1), data: e.data }))
      .filter((f) => f.path && !f.path.split('/').some((c) => c === '..' || c === '.')),
  }));
}

// ── What the Options screen calls ──

const state = {
  busy: false,
  message: '',
  // Bumped on every change to the installed set, so the screen knows to read the list again.
  rev: 0,
};

async function removeFolder(db, name) {
  const prefix = `${name.toLowerCase()}/`;
  const gone = [...files.keys()].filter((k) => k.startsWith(prefix));
  await tx(db, 'readwrite', (s) => gone.forEach((k) => s.delete(k)));
  gone.forEach((k) => files.delete(k));
}

async function installZips(list) {
  const db = await openDb();
  const names = [];
  const problems = [];
  for (const file of list) {
    try {
      const addons = addonsIn(await unzip(await file.arrayBuffer()));
      if (!addons.length) {
        problems.push(`${file.name} holds no addon (no .toc file)`);
        continue;
      }
      for (const addon of addons) {
        await removeFolder(db, addon.name);
        const rows = addon.files.map((f) => {
          const name = `${addon.name}/${f.path}`;
          return { key: name.toLowerCase(), name, data: f.data };
        });
        await tx(db, 'readwrite', (s) => rows.forEach((r) => s.put(r)));
        rows.forEach((r) => files.set(r.key, { name: r.name, data: r.data }));
        names.push(addon.name);
      }
    } catch (e) {
      problems.push(`${file.name}: ${e?.message || e}`);
    }
  }
  db.close();
  reindex();
  const parts = [];
  if (names.length) parts.push(`Installed ${names.join(', ')}. It loads at your next run.`);
  parts.push(...problems);
  return parts.join(' ');
}

function pickZips() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (v) => { if (!done) { done = true; input.remove(); resolve(v); } };
    input.addEventListener('change', () => finish([...input.files]));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

async function run(job) {
  if (state.busy) return;
  state.busy = true;
  state.message = '';
  state.rev++;
  try {
    state.message = await job();
  } catch (e) {
    state.message = `Something went wrong: ${e?.message || e}`;
  } finally {
    state.busy = false;
    state.rev++;
  }
}

window.__rogue_addons = {
  state,
  // The player picks one or more addon .zip files; they replace any installed addon of a name.
  install() {
    run(async () => {
      const picked = await pickZips();
      return picked.length ? installZips(picked) : '';
    });
  },
  remove(name) {
    run(async () => {
      const db = await openDb();
      await removeFolder(db, name);
      db.close();
      reindex();
      return `Removed ${name}.`;
    });
  },
};

// Read every installed file into memory, before the client asks for one.
export async function mount() {
  const db = await openDb();
  const rows = await tx(db, 'readonly', (s) => s.getAll());
  db.close();
  for (const r of rows || []) index(r.name, r.data);
}
