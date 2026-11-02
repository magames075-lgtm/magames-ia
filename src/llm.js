// Motores de IA de texto com fallback automático.
// Ordem automática: chaves grátis do usuário (Gemini/Groq/OpenRouter) → LLM7 (grátis, sem chave, cota diária por IP) → WebLLM offline (WebGPU, ilimitado).
// Obs.: o texto anônimo da Pollinations passou a exigir Turnstile em navegadores (403) e 1 resposta/45 s por IP, então não é usado no chat.
import { settings, saveSettings } from './store.js';

const PROVIDERS = {
  llm7: { name: 'LLM7', url: 'https://api.llm7.io/v1/chat/completions', model: () => settings.models.llm7 || 'default', key: () => settings.keys.llm7 || 'anon' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: () => settings.models.groq || 'llama-3.3-70b-versatile', key: () => settings.keys.groq },
  gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: () => settings.models.gemini || 'gemini-2.5-flash', key: () => settings.keys.gemini },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: () => settings.models.openrouter || 'meta-llama/llama-3.3-70b-instruct:free', key: () => settings.keys.openrouter },
};
export const PROVIDER_NAMES = { ...Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.name])), offline: 'Offline' };

export function hasWebGPU() { return typeof navigator !== 'undefined' && 'gpu' in navigator; }

function chain() {
  const keyed = ['gemini', 'groq', 'openrouter'].filter((p) => settings.keys[p]);
  const offline = settings.offlineReady && hasWebGPU() ? ['offline'] : [];
  const base = [...keyed, 'llm7', ...offline];
  const pref = settings.backend;
  if (pref === 'auto' || !pref || (!PROVIDERS[pref] && pref !== 'offline')) return base;
  return [pref, ...base.filter((p) => p !== pref)];
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function streamOpenAI(pid, messages, { onToken, onReasoning, signal, temperature, model }) {
  const p = PROVIDERS[pid];
  const key = p.key();
  if (!key) throw new Error(p.name + ': sem chave');
  const body = { model: model || p.model(), messages, stream: true, temperature: temperature ?? 0.7 };
  const headers = { 'Content-Type': 'application/json' };
  if (key !== 'anon') headers.Authorization = 'Bearer ' + key;
  if (pid === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'MaGames IA'; }
  const res = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let t = ''; try { t = (await res.text()).slice(0, 300); } catch {}
    const err = new HttpError(res.status, `${p.name} ${res.status}: ${t}`);
    const m = t.match(/"retry_after"\s*:\s*(\d+)/) || t.match(/[Rr]etry after (\d+)/);
    err.retryAfter = m ? Number(m[1]) : Number(res.headers.get('retry-after')) || 0;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) { // alguns provedores ignoram stream
    const j = await res.json();
    const txt = j.choices?.[0]?.message?.content || '';
    if (txt) onToken?.(txt);
    return txt;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(j.error.message || 'erro do provedor');
        const d = j.choices?.[0]?.delta || {};
        if (d.content) { full += d.content; onToken?.(d.content); }
        else if (d.reasoning || d.reasoning_content) onReasoning?.(d.reasoning || d.reasoning_content);
      } catch (e) { if (e.message && !e.message.startsWith('Unexpected') && !e.message.includes('JSON')) throw e; }
    }
  }
  return full;
}

// ---------- WebLLM offline ----------
let webllmMod = null, engine = null, engineModel = null, enginePromise = null;
async function getWebLLM() { return webllmMod || (webllmMod = await import('@mlc-ai/web-llm')); }

export async function loadOffline(onProgress) {
  if (!hasWebGPU()) throw new Error('Seu navegador não tem WebGPU. Use Chrome/Edge atualizado (Android 12+ ou PC).');
  const model = settings.offlineModel;
  if (engine && engineModel === model) return engine;
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const webllm = await getWebLLM();
    if (engine) { try { await engine.unload(); } catch {} }
    engine = await webllm.CreateMLCEngine(model, { initProgressCallback: (r) => onProgress?.(r.progress ?? 0, r.text || '') });
    engineModel = model;
    settings.offlineReady = true; saveSettings();
    return engine;
  })();
  try { return await enginePromise; } finally { enginePromise = null; }
}

export async function offlineCached(model = settings.offlineModel) {
  try { const w = await getWebLLM(); return await w.hasModelInCache(model); } catch { return false; }
}

export async function deleteOffline(model = settings.offlineModel) {
  const w = await getWebLLM();
  if (engine && engineModel === model) { try { await engine.unload(); } catch {} engine = null; engineModel = null; }
  await w.deleteModelAllInfoInCache(model);
  settings.offlineReady = false; saveSettings();
}

async function streamOffline(messages, { onToken, signal, onLoad }) {
  const eng = await loadOffline(onLoad);
  const stream = await eng.chat.completions.create({ messages, stream: true, temperature: 0.7, max_tokens: 2048 });
  let full = '';
  for await (const ch of stream) {
    if (signal?.aborted) { try { eng.interruptGenerate(); } catch {} break; }
    const t = ch.choices?.[0]?.delta?.content;
    if (t) { full += t; onToken?.(t); }
  }
  return full;
}

/**
 * Envia mensagens e faz streaming. Tenta os motores em ordem até um funcionar.
 * opts: { onToken, onReasoning, onProvider, onLoad, signal, temperature, only }
 */
export async function chat(messages, opts = {}) {
  const order = opts.only ? [opts.only] : chain();
  const errors = [];
  for (const pid of order) {
    if (opts.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    let got = false;
    const wrapped = { ...opts, onToken: (t) => { got = true; opts.onToken?.(t); } };
    // LLM7 sem chave: cada modelo tem sua cota; se um esgotar, tenta os outros gratuitos
    const models = pid === 'llm7' ? [...new Set([PROVIDERS.llm7.model(), 'default', 'fast', 'gpt-oss:20b', 'mistral-Nemo-Instruct-2407', 'codestral-latest'])] : [undefined];
    let done = null;
    for (let mi = 0; mi < models.length && !done; mi++) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          opts.onProvider?.(pid);
          const text = pid === 'offline' ? await streamOffline(messages, wrapped) : await streamOpenAI(pid, messages, { ...wrapped, model: models[mi] });
          if (!text && !got) throw new Error(PROVIDER_NAMES[pid] + ': resposta vazia');
          done = { text, provider: pid }; break;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          console.warn('[llm]', pid, models[mi] || '', e.message);
          if (got) return { text: '', provider: pid, partial: true }; // já mostrou parte: não duplica
          const quota = e.status === 429 && /quota/i.test(e.message);
          const ra = e.retryAfter || (e.status === 429 ? 3 : 0);
          errors.push(quota && ra > 10 ? `${PROVIDER_NAMES[pid]}: cota grátis do dia esgotada` : (e.message || String(e)).slice(0, 160));
          if ((e.status === 429 || e.status === 503 || e.status === 502) && attempt === 0 && ra <= 10) { await new Promise((r) => setTimeout(r, (ra || 2) * 1000 + 300)); continue; }
          if (pid === 'llm7') await new Promise((r) => setTimeout(r, 1100)); // limite de 1 req/s
          break;
        }
      }
    }
    if (done) return done;
  }
  const err = new Error('Nenhum motor respondeu. ' + errors.join(' | '));
  err.all = errors; throw err;
}

/** Resposta completa (sem streaming na UI). */
export async function complete(messages, opts = {}) {
  let out = '';
  const r = await chat(messages, { ...opts, onToken: (t) => { out += t; } });
  return r.text || out;
}

/** Extrai JSON de uma resposta do modelo. */
export function extractJSON(text) {
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const s = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
  if (s === Infinity) throw new Error('sem JSON');
  const open = t[s], close = open === '{' ? '}' : ']';
  const e = t.lastIndexOf(close);
  t = t.slice(s, e + 1);
  try { return JSON.parse(t); }
  catch { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"')); }
}
