// Voz: vozes neurais Microsoft (edge-tts) geradas no servidor → MP3. Reserva: voz do sistema do aparelho.
import { apiFetch, apiJSON } from './api.js';

export const FALLBACK_VOICES = [
  { id: 'pt-BR-FranciscaNeural', name: 'Francisca', desc: 'feminina, calorosa', lang: 'pt-BR' },
  { id: 'pt-BR-AntonioNeural', name: 'Antônio', desc: 'masculina, clara', lang: 'pt-BR' },
  { id: 'pt-BR-ThalitaMultilingualNeural', name: 'Thalita', desc: 'feminina, jovem', lang: 'pt-BR' },
];
let voicesCache = null;
export async function getVoices() {
  if (voicesCache) return voicesCache;
  try { voicesCache = (await apiJSON('/api/voices')).voices; } catch { voicesCache = FALLBACK_VOICES; }
  return voicesCache;
}

/** rate: multiplicador (1 = normal) */
export async function ttsBlob(text, voice, rate = 1, { signal } = {}) {
  const r = await apiFetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, rate: Math.round((rate - 1) * 100) }), signal });
  const b = await r.blob();
  if (b.size < 500) throw new Error('áudio vazio');
  return b;
}

export function cleanForSpeech(text) {
  return text.replace(/```[\s\S]*?```/g, ' (código omitido) ').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/[#*_`>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function speakSystem(text, rate = 1) {
  return new Promise((res, rej) => {
    if (!('speechSynthesis' in window)) return rej(new Error('sem voz no aparelho'));
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
    const v = speechSynthesis.getVoices().find((x) => x.lang?.replace('_', '-').startsWith('pt'));
    if (v) u.voice = v; u.lang = 'pt-BR'; u.rate = rate;
    u.onend = res; u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? res() : rej(new Error(e.error)));
    speechSynthesis.speak(u);
  });
}
export function stopSystem() { try { speechSynthesis.cancel(); } catch {} }

let quick = null;
export async function speakQuick(text, voice) {
  stopQuick();
  const plain = cleanForSpeech(text).slice(0, 6000);
  try {
    const b = await ttsBlob(plain, voice);
    quick = new Audio(URL.createObjectURL(b));
    await quick.play();
  } catch (e) {
    console.warn('TTS servidor falhou, usando voz do aparelho', e);
    await speakSystem(plain);
  }
}
export function stopQuick() { stopSystem(); if (quick) { quick.pause(); quick = null; } }
