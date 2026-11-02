import { load, save, toast, downloadBlob, sleep, uid, settings } from './store.js';
import { complete } from './llm.js';
import { idbPut, idbGet, idbDel, idbClear } from './idb.js';

const $ = (s) => document.querySelector(s);
let gallery = load('gallery', []); // { id, prompt, w, h, seed, t, src:'ai'|'foto' }
let nextFreeAt = Number(sessionStorage.getItem('mgia.imgNext') || 0); // limite grátis: ~1 imagem / 45 s por IP

export class LimitError extends Error { constructor(wait) { super(`Limite grátis: próxima imagem em ${wait}s`); this.wait = wait; } }

// Sem chave: a Pollinations só libera a imagem como <img> comum (sem CORS; fetch() recebe 403 "Turnstile")
// e no máximo ~1 imagem a cada 45 s por IP. Com chave Pollinations (opcional) usamos fetch com Authorization.
export function imageURL(prompt, w, h, seed, model = 'flux') {
  const p = encodeURIComponent(prompt.slice(0, 900));
  return `https://image.pollinations.ai/prompt/${p}?width=${w}&height=${h}&seed=${seed}&model=${model}&nologo=true&safe=true`;
}
export function secondsUntilFree() { return Math.max(0, Math.ceil((nextFreeAt - Date.now()) / 1000)); }
function markUsed(sec = 46) { nextFreeAt = Date.now() + sec * 1000; sessionStorage.setItem('mgia.imgNext', String(nextFreeAt)); }
export function hasImageKey() { return !!settings.keys.pollinations; }

/** Imagem IA como Blob (necessário para vídeo/baixar). Exige chave Pollinations. */
export async function fetchImage(prompt, w, h, seed, { signal, tries = 3 } = {}) {
  if (!hasImageKey()) throw new Error('sem chave Pollinations');
  let last;
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt.slice(0, 900))}?width=${w}&height=${h}&seed=${seed + i * 7919}&model=${settings.models.pollinationsImage || 'flux'}&nologo=true`;
      const r = await fetch(url, { signal, headers: { Authorization: 'Bearer ' + settings.keys.pollinations } });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('chave Pollinations recusada (' + r.status + ')'), { fatal: true });
      if (r.status === 402) throw Object.assign(new Error('saldo Pollinations esgotado'), { fatal: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.blob();
      if (!b.type.startsWith('image/') || b.size < 2000) throw new Error('resposta inválida');
      return b;
    } catch (e) { if (e.name === 'AbortError' || e.fatal) throw e; last = e; await sleep(2000 * (i + 1)); }
  }
  throw last || new Error('falha ao gerar imagem');
}

/** Sem chave: carrega como <img> respeitando o limite grátis. Resolve com a URL quando a imagem carregou. */
async function loadFreeImage(prompt, w, h, seed, { signal, onWait }) {
  for (let i = 0; i < 3; i++) {
    let wait;
    while ((wait = secondsUntilFree()) > 0) { onWait?.(wait); await sleep(1000); if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError'); }
    const url = imageURL(prompt, w, h, seed + i);
    markUsed();
    // Quando o limite estoura, a Pollinations devolve uma imagem-aviso ("Free limit reached") de 1024 px.
    // Pedimos no máximo 768 px (teto do plano grátis) e conferimos o tamanho exato para detectar o aviso.
    const ok = await new Promise((res) => { const im = new Image(); const t = setTimeout(() => res(false), 120000); im.onload = () => { clearTimeout(t); res(im.naturalWidth === w && im.naturalHeight === h ? true : 'limit'); }; im.onerror = () => { clearTimeout(t); res(false); }; im.src = url; });
    if (ok === 'limit') { markUsed(46); continue; }
    if (ok) return url;
  }
  throw new Error('o serviço grátis de imagens não respondeu');
}

/** Foto real de licença livre (Wikimedia Commons), sem chave. */
export async function fetchStockPhoto(query, w, { signal, skip = 0 } = {}) {
  const q = encodeURIComponent(query.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 5).join(' ') + ' filetype:bitmap');
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=${w > 960 ? 1280 : 960}&format=json&origin=*`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error('Wikimedia HTTP ' + r.status);
  const j = await r.json();
  const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index)
    .map((p) => p.imageinfo?.[0]).filter((ii) => ii && /jpeg|png|webp/.test(ii.mime || '') && ii.width >= 640 && ii.thumburl);
  if (!pages.length) throw new Error('nenhuma foto encontrada');
  let last;
  for (let k = 0; k < Math.min(4, pages.length); k++) {
    const pick = pages[(skip + k) % pages.length];
    try {
      const ir = await fetch(pick.thumburl, { signal });
      if (!ir.ok) throw new Error('foto HTTP ' + ir.status);
      const blob = await ir.blob();
      if (!blob.type.startsWith('image/')) throw new Error('foto inválida');
      return { blob, credit: pick.descriptionurl || pick.descriptionshorturl || '' };
    } catch (e) { if (e.name === 'AbortError') throw e; last = e; await sleep(1200 * (k + 1)); }
  }
  throw last;
}

function persist() { save('gallery', gallery.slice(0, 60)); }

async function card(item) {
  const fig = document.createElement('figure');
  fig.style.setProperty('--ar', `${item.w}/${item.h}`);
  const blob = item.url ? null : await idbGet(item.id).catch(() => null);
  if (!blob && !item.url) return null;
  const url = blob ? URL.createObjectURL(blob) : item.url;
  const img = document.createElement('img');
  img.alt = item.prompt; img.decoding = 'async'; img.src = url;
  img.onclick = () => { const lb = document.createElement('div'); lb.className = 'lightbox'; const im = new Image(); im.src = url; lb.appendChild(im); lb.onclick = () => lb.remove(); document.body.appendChild(lb); };
  const cap = document.createElement('figcaption');
  const mk = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; cap.appendChild(b); };
  if (blob) mk('⬇ baixar', () => downloadBlob(blob, 'magames-ia-' + item.seed + '.jpg'));
  else mk('⬇ abrir', () => { window.open(url, '_blank', 'noopener'); toast('Toque e segure na imagem para salvar'); });
  if (blob && navigator.canShare?.({ files: [new File([blob], 'img.jpg', { type: blob.type })] })) mk('↗', () => navigator.share({ files: [new File([blob], 'magames-ia.jpg', { type: blob.type })] }).catch(() => {}));
  mk('🗑', async () => { gallery = gallery.filter((g) => g !== item); persist(); await idbDel(item.id).catch(() => {}); renderGallery(); });
  fig.append(img, cap);
  return fig;
}

export async function renderGallery() {
  const g = $('#gallery');
  const figs = await Promise.all(gallery.map(card));
  g.innerHTML = '';
  figs.forEach((f) => f && g.appendChild(f));
}

let genAbort = null;
async function generate(prompt, w, h, n) {
  const btn = $('#btnGenImg');
  if (genAbort) { genAbort.abort(); return; }
  genAbort = new AbortController();
  btn.textContent = 'Cancelar';
  try {
    for (let i = 0; i < n; i++) {
      const seed = Math.floor(Math.random() * 1e9);
      const ph = document.createElement('figure'); ph.style.setProperty('--ar', `${w}/${h}`);
      ph.innerHTML = '<div class="loading">gerando…</div>'; $('#gallery').prepend(ph);
      try {
        const item = { id: uid(), prompt, w, h, seed, t: Date.now() };
        if (hasImageKey()) {
          const blob = await fetchImage(prompt, w, h, seed, { signal: genAbort.signal });
          await idbPut(item.id, blob);
        } else {
          item.url = await loadFreeImage(prompt, w, h, seed, { signal: genAbort.signal, onWait: (s) => (ph.firstChild.textContent = `limite grátis: aguarde ${s}s`) });
        }
        gallery.unshift(item); persist();
      } catch (e) {
        if (e.name === 'AbortError') break;
        toast('Não consegui gerar agora: ' + e.message);
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
    } catch (e) { toast('Não deu para melhorar agora'); }
    finally { b.disabled = false; b.textContent = '✨ Melhorar prompt'; }
  };
  $('#btnClearGallery').onclick = async () => { if (confirm('Limpar a galeria?')) { gallery = []; persist(); await idbClear().catch(() => {}); renderGallery(); } };
}
