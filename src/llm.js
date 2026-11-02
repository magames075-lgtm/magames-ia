// Chat via backend MaGames IA (Gemini → Groq → LLM7 no servidor, com fallback automático).
import { streamChat, ApiError } from './api.js';

export const PROVIDER_NAMES = { gemini: 'Gemini', groq: 'Groq', llm7: 'LLM7' };

/**
 * opts: { onToken, onProvider, signal, temperature }
 * Retorna { text, provider }.
 */
export async function chat(messages, opts = {}) {
  let text = '', provider = '', error = '';
  await streamChat({ messages, temperature: opts.temperature ?? 0.7 }, (ev) => {
    if (ev.provider) { provider = ev.provider; opts.onProvider?.(ev.provider); }
    if (ev.t) { text += ev.t; opts.onToken?.(ev.t); }
    if (ev.error) error = ev.error;
  }, opts.signal);
  if (!text) throw new ApiError(error || 'A IA não respondeu. Toque em tentar de novo.', 502);
  return { text, provider, partial: !!error };
}

export async function complete(messages, opts = {}) {
  const r = await chat(messages, opts);
  return r.text;
}

export function extractJSON(text) {
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const s = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
  if (s === Infinity) throw new Error('sem JSON');
  const close = t[s] === '{' ? '}' : ']';
  t = t.slice(s, t.lastIndexOf(close) + 1);
  try { return JSON.parse(t); } catch { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"')); }
}
