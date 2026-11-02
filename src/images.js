// Gerador de imagens via backend (Gemini / Pollinations no servidor). Imagens salvas no aparelho (IndexedDB).
import { load, save, toast, downloadBlob, sleep, uid } from './store.js';
import { complete } from './llm.js';
import { apiFetch, friendly } from './api.js';
import { idbPut, idbGet, idbDel, idbClear } from './idb.js';

const $ = (s) => document.querySelector(s);
let gallery = load('gallery2', []); // { id, prompt, w, h, t, provider }
const urls = new Map();

function persist() { save('gallery2', gallery.slice(0, 80)); }

export async function generateImageBlob(prompt, w, h, { signal, onWait } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await apiFetch('/api/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, width: w, height: h }), signal });
      const b = await r.blob();
      if (!b.type.startsWith('image/')) throw new Error('resposta inválida do servidor');
      return { blob: b, provider: r.headers.get('X-Provider') || '' };
    } catch (e) {
      if (e.status === 429 && e.retryAfter && e.retryAfter <= 120 && attempt < 3) {
        for (let s = e.retryAfter; s > 0; s--) { onWait?.(s); await sleep(1000); if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError'); }
        continue;
      }
      throw e;
    }
  }
  throw new Error('geradores ocupados');
}

async function card(item) {
  const blob = await idbGet(item.id).catch(() => null);
  if (!blob) return null;
  const fig = document.createElement('figure');
  fig.style.setProperty('--ar', `${item.w}/${item.h}`);
  let url = urls.get(item.id);
  if (!url) { url = URL.createObjectURL(blob); urls.set(item.id, url); }
  const img = document.createElement('img');
  img.alt = item.prompt; img.decoding = 'async'; img.loading = 'lazy'; img.src = url;
  img.onclick = () => { const lb = document.createElement('div'); lb.className = 'lightbox'; const im = new Image(); im.src = url; const p = document.createElement('p'); p.textContent = item.prompt; lb.append(im, p); lb.onclick = () => lb.remove(); document.body.appendChild(lb); };
  const cap = document.createElement('figcaption');
  const mk = (t, title, fn) => { const b = document.createElement('button'); b.textContent = t; b.title = title; b.onclick = fn; cap.appendChild(b); };
  const ext = blob.type.includes('png') ? 'png' : 'jpg';
  mk('⬇ Baixar', 'Baixar imagem', () => downloadBlob(blob, `magames-ia-${item.id}.${ext}`));
  const file = new File([blob], `magames-ia.${ext}`, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) mk('↗', 'Compartilhar', () => navigator.share({ files: [file] }).catch(() => {}));
  mk('↻', 'Gerar de novo', () => { $('#imgPrompt').value = item.prompt; generate(item.prompt, item.w, item.h, 1); });
  mk('🗑', 'Apagar', async () => { gallery = gallery.filter((g) => g !== item); persist(); await idbDel(item.id).catch(() => {}); renderGallery(); });
  fig.append(img, cap);
  return fig;
}

export async function renderGallery() {
  const g = $('#gallery');
  const figs = await Promise.all(gallery.map(card));
  g.querySelectorAll('figure:not(.pending)').forEach((f) => f.remove());
  figs.forEach((f) => f && g.appendChild(f));
  $('#galleryEmpty').hidden = gallery.length > 0;
}

let genAbort = null;
async function generate(prompt, w, h, n) {
  const btn = $('#btnGenImg');
  if (genAbort) { genAbort.abort(); return; }
  genAbort = new AbortController();
  btn.textContent = 'Cancelar';
  try {
    for (let i = 0; i < n; i++) {
      const ph = document.createElement('figure'); ph.className = 'pending'; ph.style.setProperty('--ar', `${w}/${h}`);
      ph.innerHTML = `<div class="loading"><span class="spinner"></span><span>Gerando ${n > 1 ? `${i + 1}/${n}` : ''}…</span></div>`;
      $('#gallery').prepend(ph);
      try {
        const { blob, provider } = await generateImageBlob(prompt, w, h, { signal: genAbort.signal, onWait: (s) => (ph.querySelector('.loading span:last-child').textContent = `Fila grátis: ${s}s…`) });
        const item = { id: uid(), prompt, w, h, t: Date.now(), provider };
        await idbPut(item.id, blob);
        gallery.unshift(item); persist();
      } catch (e) {
        if (e.name === 'AbortError') break;
        toast('Imagem: ' + friendly(e), 6000);
      } finally { ph.remove(); }
      await renderGallery();
    }
  } finally { genAbort = null; btn.textContent = 'Gerar imagem'; }
}

export function initImages() {
  renderGallery();
  $('#btnGenImg').onclick = () => {
    if (genAbort) { genAbort.abort(); return; }
    const base = $('#imgPrompt').value.trim();
    if (!base) return toast('Descreva a imagem primeiro');
    const style = $('#imgStyle').value;
    const [w, h] = $('#imgAspect').value.split('x').map(Number);
    generate(style ? `${base}, ${style}` : base, w, h, Number($('#imgCount').value));
  };
  $('#btnEnhance').onclick = async () => {
    const t = $('#imgPrompt').value.trim(); if (!t) return toast('Escreva uma ideia primeiro');
    const b = $('#btnEnhance'); b.disabled = true; b.textContent = '✨ …';
    try {
      const out = await complete([{ role: 'system', content: 'You write prompts for an image generator. Reply ONLY with one detailed English prompt (max 70 words): subject, scene, composition, lighting, style, camera. No quotes, no preface.' }, { role: 'user', content: t }]);
      if (out.trim()) $('#imgPrompt').value = out.trim().replace(/^"|"$/g, '');
    } catch (e) { toast('Não deu para melhorar agora: ' + friendly(e)); }
    finally { b.disabled = false; b.textContent = '✨ Melhorar prompt'; }
  };
  $('#btnClearGallery').onclick = async () => { if (confirm('Apagar todas as imagens da galeria?')) { gallery = []; persist(); await idbClear().catch(() => {}); renderGallery(); } };
}
