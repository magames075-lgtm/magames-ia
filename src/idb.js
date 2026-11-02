// IndexedDB mínimo para guardar imagens (blobs) da galeria
const DB = 'mgia', STORE = 'blobs';
let dbp = null;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); }); }
export const idbPut = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const idbGet = (k) => tx('readonly', (s) => s.get(k));
export const idbDel = (k) => tx('readwrite', (s) => s.delete(k));
export const idbClear = () => tx('readwrite', (s) => s.clear());
