// Cliente do backend MaGames IA (Render free). Cuida de "acordar" o servidor, repetir pedidos e manter vivo.
export const API = (import.meta.env.VITE_API_URL || 'https://magames-ia-api.onrender.com').replace(/\/$/, '');

let awake = false;
let wakePromise = null;
const listeners = new Set();
export function onServerState(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }
let state = 'unknown'; // unknown | waking | ok | down
function setState(s) { if (s === state) return; state = s; listeners.forEach((f) => f(s)); }

export class ApiError extends Error {
  constructor(msg, status = 0, retryAfter = 0) { super(msg); this.status = status; this.retryAfter = retryAfter; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(timeout = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try { const r = await fetch(API + '/api/health', { signal: ctl.signal, cache: 'no-store' }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}

/** Garante que o servidor está acordado (Render grátis dorme após 15 min sem uso; acordar leva ~50 s). */
export function wake() {
  if (awake) return Promise.resolve(true);
  if (wakePromise) return wakePromise;
  wakePromise = (async () => {
    const t0 = Date.now();
    let first = true;
    while (Date.now() - t0 < 120000) {
      const h = await ping(first ? 6000 : 15000);
      if (h?.ok) { awake = true; setState('ok'); return true; }
      if (first) setState('waking');
      first = false;
      await sleep(2500);
    }
    setState('down');
    throw new ApiError('O servidor não respondeu. Verifique sua internet e toque em tentar de novo.', 0);
  })();
  wakePromise.finally(() => { wakePromise = null; });
  return wakePromise;
}

/** fetch no backend com acordar + repetição em falhas de rede/502/503. */
export async function apiFetch(path, opts = {}, { tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (opts.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      await wake();
      const r = await fetch(API + path, { cache: 'no-store', ...opts });
      if (r.status === 502 || r.status === 503 || r.status === 504) {
        // servidor reiniciando/acordando
        awake = false; last = new ApiError('Servidor reiniciando…', r.status);
        await sleep(3000 * (i + 1)); continue;
      }
      if (!r.ok) {
        let j = {}; try { j = await r.json(); } catch {}
        throw new ApiError(j.error || `Erro ${r.status}`, r.status, j.retry_after || Number(r.headers.get('X-Retry-After')) || 0);
      }
      setState('ok');
      return r;
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof ApiError && e.status && e.status !== 502 && e.status !== 503) throw e;
      last = e instanceof ApiError ? e : new ApiError('Sem conexão com o servidor. Verifique sua internet.', 0);
      awake = false;
      await sleep(2000 * (i + 1));
    }
  }
  throw last;
}

export async function apiJSON(path, body, opts = {}) {
  const r = await apiFetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, ...opts });
  return r.json();
}

/** Chat em streaming (SSE). onEvent({t}|{provider}|{error}) */
export async function streamChat(payload, onEvent, signal) {
  const r = await apiFetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal }, { tries: 3 });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') return;
        try { onEvent(JSON.parse(d)); } catch {}
      }
    }
  }
}

// keep-alive: enquanto o app está aberto e visível, um ping a cada 4 min evita o servidor dormir.
let kaTimer = null;
export function startKeepAlive() {
  if (kaTimer) return;
  kaTimer = setInterval(() => { if (document.visibilityState === 'visible') ping(15000).then((h) => { if (h?.ok) { awake = true; setState('ok'); } }); }, 240000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { awake = false; wake().catch(() => {}); } });
}

export function friendly(e) {
  if (!e) return 'Erro desconhecido';
  if (e.name === 'AbortError') return 'Cancelado';
  if (e.status === 429) return e.message + (e.retryAfter ? ` (tente em ~${e.retryAfter}s)` : '');
  return e.message || String(e);
}
