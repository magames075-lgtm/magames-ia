// Voz: Piper TTS neural no navegador (onnxruntime-web) + vozes do sistema como reserva.
let piperMod = null;
let currentVoice = null;
let session = null;

export const PIPER_VOICES = [
  { id: 'pt_BR-faber-medium', label: 'Faber — masculina, natural (Piper, ~63 MB)' },
];

async function piper() { return piperMod || (piperMod = await import('@mintplex-labs/piper-tts-web')); }

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

export async function piperSession(voiceId, onProgress) {
  const m = await piper();
  if (session && currentVoice === voiceId) return session;
  m.TtsSession._instance = null; // a lib reaproveita a sessão anterior; forçamos nova para trocar de voz
  session = await m.TtsSession.create({
    voiceId,
    progress: (p) => { if (p && p.total) onProgress?.(p.loaded / p.total, 'Baixando voz ' + Math.round((p.loaded / p.total) * 100) + '%'); },
  });
  currentVoice = voiceId;
  return session;
}

export async function piperStored() { try { return await (await piper()).stored(); } catch { return []; } }
export async function piperFlush() { const m = await piper(); await m.flush(); session = null; currentVoice = null; m.TtsSession._instance = null; }

/** Divide texto em pedaços curtos (frases), bom para TTS e legendas. */
export function splitSentences(text, max = 220) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…;:])\s+/);
  const out = [];
  for (let p of parts) {
    while (p.length > max) {
      let cut = p.lastIndexOf(',', max);
      if (cut < max * 0.4) cut = p.lastIndexOf(' ', max);
      if (cut < 20) cut = max;
      out.push(p.slice(0, cut + 1).trim()); p = p.slice(cut + 1).trim();
    }
    if (p) {
      if (out.length && out[out.length - 1].length + p.length < 90) out[out.length - 1] += ' ' + p;
      else out.push(p);
    }
  }
  return out;
}

/** Junta vários WAV PCM16 mono do Piper em um só, com pausa entre eles. */
export async function concatWavs(blobs, gapSec = 0.25) {
  let rate = 22050;
  const pcs = [];
  for (const b of blobs) {
    const buf = await b.arrayBuffer();
    const dv = new DataView(buf);
    rate = dv.getUint32(24, true);
    pcs.push(new Uint8Array(buf, 44));
  }
  const gap = new Uint8Array(Math.round(rate * gapSec) * 2);
  const total = pcs.reduce((s, p) => s + p.length, 0) + gap.length * Math.max(0, pcs.length - 1);
  const out = new Uint8Array(44 + total);
  const dv = new DataView(out.buffer);
  const w = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + total, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, total, true);
  let o = 44;
  pcs.forEach((p, i) => { out.set(p, o); o += p.length; if (i < pcs.length - 1) { out.set(gap, o); o += gap.length; } });
  return { blob: new Blob([out], { type: 'audio/wav' }), duration: total / 2 / rate };
}

export function wavDuration(buf) { const dv = new DataView(buf); return dv.getUint32(40, true) / dv.getUint32(28, true); }

/** Sintetiza texto longo com Piper. Retorna { blob, duration, pieces:[{text,duration}] } */
export async function synthPiper(text, voiceId, { onProgress, signal } = {}) {
  const s = await piperSession(voiceId, onProgress);
  const chunks = splitSentences(text);
  const blobs = [], pieces = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    onProgress?.(i / chunks.length, `Gerando voz ${i + 1}/${chunks.length}`);
    const b = await withTimeout(s.predict(chunks[i]), 90000, 'A voz Piper travou neste aparelho.');
    blobs.push(b);
    pieces.push({ text: chunks[i], duration: wavDuration(await b.arrayBuffer()) });
  }
  onProgress?.(1, 'Pronto');
  const gap = 0.25;
  const { blob, duration } = await concatWavs(blobs, gap);
  return { blob, duration, pieces, gap };
}

// ---------- vozes do sistema (speechSynthesis) ----------
export function systemVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => /^pt/i.test(v.lang)).sort((a, b) => (b.lang === 'pt-BR') - (a.lang === 'pt-BR'));
}

export function speakSystem(text, voiceName, rate = 1) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) return reject(new Error('Sem voz do sistema neste navegador'));
    speechSynthesis.cancel();
    const chunks = splitSentences(text, 200);
    const v = speechSynthesis.getVoices().find((x) => x.name === voiceName) || systemVoices()[0];
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return resolve();
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      if (v) u.voice = v; u.lang = v?.lang || 'pt-BR'; u.rate = rate;
      let done = false;
      const guard = setTimeout(() => { if (!done) { done = true; speechSynthesis.cancel(); reject(new Error('a voz do sistema não respondeu')); } }, 8000 + u.text.length * 150 / rate);
      u.onend = () => { if (done) return; done = true; clearTimeout(guard); next(); };
      u.onerror = (e) => { if (done) return; done = true; clearTimeout(guard); (e.error === 'interrupted' || e.error === 'canceled' ? resolve() : reject(new Error(e.error))); };
      speechSynthesis.speak(u);
    };
    next();
  });
}
export function stopSystem() { try { speechSynthesis.cancel(); } catch {} }

// ---------- leitura rápida de respostas do chat ----------
let chatAudio = null;
export async function speakQuick(text, voicePref, rate = 1) {
  stopQuick();
  const plain = text.replace(/```[\s\S]*?```/g, ' (código omitido) ').replace(/[#*_`>|-]/g, ' ').replace(/\[(.*?)\]\(.*?\)/g, '$1');
  if (voicePref?.startsWith('piper:') ) {
    try {
      const { blob } = await synthPiper(plain, voicePref.slice(6));
      chatAudio = new Audio(URL.createObjectURL(blob)); chatAudio.playbackRate = rate; await chatAudio.play();
      return;
    } catch (e) { console.warn('Piper falhou, usando voz do sistema', e); }
  }
  await speakSystem(plain, voicePref?.startsWith('sys:') ? voicePref.slice(4) : '', rate);
}
export function stopQuick() { stopSystem(); if (chatAudio) { chatAudio.pause(); chatAudio = null; } }
