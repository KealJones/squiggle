// Small shared helpers: ids, token estimates, a key-value store on IndexedDB,
// and a tiny event emitter.

// Ids sort in creation order on a device (time, then a counter), with a random
// tail so two devices never collide.
let lastMs = 0, seq = 0;
export const uid = (prefix = '') => {
  const ms = Date.now();
  seq = ms === lastMs ? seq + 1 : 0;
  lastMs = ms;
  return prefix + ms.toString(36).padStart(9, '0') + seq.toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 7);
};

// A timestamp that never repeats or goes backwards on this device.
let lastTs = 0;
export const monotonicNow = () => (lastTs = Math.max(Date.now(), lastTs + 1));

// Gemma's tokenizer averages ~3.5-4 characters per token for English prose and
// fewer for code/JSON. 3.2 errs on the side of over-counting, which is the
// safe direction when filling a fixed context budget.
export const estTokens = (s) => Math.ceil(String(s || '').length / 3.2);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function truncate(s, max) {
  s = String(s ?? '');
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

// ── IndexedDB key-value store ──────────────────────────────────────────────
// Stores: 'kv' (settings, auth, sync bookkeeping) and 'model' (downloaded
// model chunks, keyed [url, index]).
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('squiggle', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('model')) d.createObjectStore('model');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Runs a synchronous write against one store; resolves when it commits.
function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    fn(t.objectStore(store));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const kv = {
  async get(key, store = 'kv') {
    const d = await db();
    return reqP(d.transaction(store).objectStore(store).get(key));
  },
  set(key, value, store = 'kv') { return tx(store, 'readwrite', s => { s.put(value, key); }); },
  del(key, store = 'kv') { return tx(store, 'readwrite', s => { s.delete(key); }); },
  async keys(range, store = 'kv') {
    const d = await db();
    return reqP(d.transaction(store).objectStore(store).getAllKeys(range));
  },
  delRange(range, store = 'kv') { return tx(store, 'readwrite', s => { s.delete(range); }); },
};

// ── Event emitter ──────────────────────────────────────────────────────────
export function emitter() {
  const handlers = new Map();
  return {
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, new Set());
      handlers.get(evt).add(fn);
      return () => handlers.get(evt).delete(fn);
    },
    emit(evt, data) { for (const fn of handlers.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } } },
  };
}

// Serializes async work: run(fn) waits for everything queued before it.
export function mutex() {
  let last = Promise.resolve();
  return (fn) => {
    const run = last.then(fn, fn);
    last = run.catch(() => {});
    return run;
  };
}
