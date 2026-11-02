// Estúdio de vídeos longos: roteiro (LLM) → imagens (Pollinations) → narração (Piper) → MP4 (ffmpeg.wasm)
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { complete, extractJSON } from './llm.js';
import { fetchImage, fetchStockPhoto, hasImageKey } from './images.js';
import { synthPiper } from './voice.js';
import { toast, setProgress, downloadBlob, sleep } from './store.js';

const $ = (s) => document.querySelector(s);
let scenes = []; // { narracao, imagem }
let ff = null;
let abort = null;

// ---------- roteiro ----------
function sceneCount(min) { return Math.max(5, Math.round((min * 60) / 10)); } // ~10 s por cena

async function genScript() {
  const topic = $('#vidTopic').value.trim();
  if (!topic) return toast('Escreva o tema do vídeo');
  const min = Number($('#vidMinutes').value), n = sceneCount(min), tone = $('#vidTone').value;
  const btn = $('#btnScript'); btn.disabled = true;
  const prog = $('#vidProgress');
  abort = new AbortController();
  try {
    setProgress(prog, 0.02, 'Planejando o roteiro…');
    let title = topic, topics = [];
    try {
      const o = extractJSON(await complete([
        { role: 'system', content: 'Você é roteirista de vídeos virais do YouTube em português do Brasil. Responda SOMENTE com JSON válido.' },
        { role: 'user', content: `Tema: "${topic}". Tom: ${tone}. Crie o plano de um vídeo narrado de ${min} minuto(s) com exatamente ${n} cenas em sequência lógica (cena 1 = gancho forte; última = conclusão com chamada para se inscrever). Formato: {"titulo":"título chamativo","topicos":["resumo curto da cena 1", "..."]}` },
      ], { signal: abort.signal, temperature: 0.8 }));
      title = o.titulo || title; topics = Array.isArray(o.topicos) ? o.topicos.slice(0, n) : [];
    } catch (e) { if (e.name === 'AbortError') throw e; console.warn('plano falhou', e); }
    while (topics.length < n) topics.push(`parte ${topics.length + 1} sobre ${topic}`);

    const out = [];
    const B = 6;
    for (let s = 0; s < n; s += B) {
      const e = Math.min(n, s + B);
      setProgress(prog, 0.05 + 0.9 * (s / n), `Escrevendo cenas ${s + 1}–${e} de ${n}…`);
      const prev = out.length ? out[out.length - 1].narracao : '';
      const ask = [
        { role: 'system', content: 'Você é roteirista e narrador de vídeos do YouTube em português do Brasil. Responda SOMENTE com um array JSON válido, sem comentários.' },
        { role: 'user', content: `Vídeo: "${title}". Tom: ${tone}.\nPlano completo:\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n${prev ? `Última frase narrada: "${prev}"\n` : ''}Escreva agora as cenas ${s + 1} a ${e}. Para cada cena: "narracao" = texto falado em português do Brasil, natural e envolvente, de 35 a 45 palavras, sem emojis e sem indicar "cena"; "imagem" = prompt em INGLÊS descrevendo uma imagem que ilustra a narração (assunto, cenário, iluminação), sem texto na imagem; "busca" = 2 a 4 palavras-chave em INGLÊS para achar uma foto real do assunto.\nFormato: [{"narracao":"...","imagem":"...","busca":"..."}]` },
      ];
      let arr = null;
      for (let t = 0; t < 3 && !arr; t++) {
        try {
          const j = extractJSON(await complete(ask, { signal: abort.signal, temperature: 0.8 }));
          arr = (Array.isArray(j) ? j : j.cenas || j.scenes || []).filter((x) => x && (x.narracao || x.narration));
          if (!arr.length) arr = null;
        } catch (err) { if (err.name === 'AbortError') throw err; await sleep(2500); }
      }
      if (!arr) throw new Error('A IA não devolveu o roteiro. Tente de novo em alguns segundos.');
      arr.slice(0, e - s).forEach((x) => out.push({ narracao: String(x.narracao || x.narration).trim(), imagem: String(x.imagem || x.image || topic).trim(), busca: String(x.busca || x.search || '').trim() }));
    }
    scenes = out; $('#vidTitle').value = title;
    renderScenes(); $('#scriptBox').hidden = false;
    setProgress(prog, 1, `Roteiro pronto: ${scenes.length} cenas. Revise e toque em “Criar vídeo”.`);
  } catch (e) {
    if (e.name !== 'AbortError') { toast(e.message); setProgress(prog, 0, 'Erro: ' + e.message); }
  } finally { btn.disabled = false; abort = null; }
}

function renderScenes() {
  const box = $('#scenes'); box.innerHTML = '';
  const words = scenes.reduce((s, c) => s + c.narracao.split(/\s+/).length, 0);
  const est = document.createElement('p'); est.className = 'hint';
  est.textContent = `${scenes.length} cenas · ~${words} palavras · duração estimada ~${Math.round(words / 3.8 / 60 * 10) / 10} min`;
  box.appendChild(est);
  scenes.forEach((sc, i) => {
    const d = document.createElement('div'); d.className = 'scene';
    d.innerHTML = `<div class="scene-head"><b>Cena ${i + 1}</b><span><button title="Subir">↑</button><button title="Apagar">🗑</button></span></div>`;
    const ta = document.createElement('textarea'); ta.rows = 3; ta.value = sc.narracao; ta.oninput = () => (sc.narracao = ta.value);
    const ip = document.createElement('input'); ip.value = sc.imagem; ip.placeholder = 'prompt da imagem IA (inglês)'; ip.oninput = () => (sc.imagem = ip.value);
    const bq = document.createElement('input'); bq.value = sc.busca || ''; bq.placeholder = 'busca de foto real (inglês)'; bq.oninput = () => (sc.busca = bq.value);
    const [up, del] = d.querySelectorAll('.scene-head button');
    up.onclick = () => { if (i > 0) { [scenes[i - 1], scenes[i]] = [scenes[i], scenes[i - 1]]; renderScenes(); } };
    del.onclick = () => { scenes.splice(i, 1); renderScenes(); };
    d.append(ta, ip, bq); box.appendChild(d);
  });
}

// ---------- utilidades de mídia ----------
async function coverJPEG(blob, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (blob) {
    const bmp = await createImageBitmap(blob);
    const s = Math.max(W / bmp.width, H / bmp.height);
    const w = bmp.width * s, h = bmp.height * s;
    g.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
    bmp.close?.();
  } else {
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#2a1b5e'); gr.addColorStop(1, '#0e5a6b');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  return new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.9));
}

function wrapLines(g, text, maxW) {
  const words = text.split(/\s+/); const lines = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  return lines;
}

/** Quebra a narração em legendas de até 2 linhas, com tempos proporcionais ao texto. */
function buildCaptions(pieces, gap, lead, W, H) {
  const g = document.createElement('canvas').getContext('2d');
  const fs = Math.round(Math.min(W, H) * (W > H ? 0.05 : 0.055));
  g.font = `700 ${fs}px system-ui, sans-serif`;
  const maxW = W * 0.86;
  const caps = []; let t = lead;
  for (const p of pieces) {
    const lines = wrapLines(g, p.text, maxW);
    const groups = []; for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2));
    const total = groups.reduce((s, gr) => s + gr.join(' ').length, 0) || 1;
    for (const gr of groups) { const d = p.duration * (gr.join(' ').length / total); caps.push({ lines: gr, start: t, end: t + d }); t += d; }
    t += gap;
  }
  return { caps, fs };
}

async function captionPNG(lines, fs, W) {
  const pad = Math.round(fs * 0.45), lh = Math.round(fs * 1.25);
  const c = document.createElement('canvas'); const g = c.getContext('2d');
  g.font = `700 ${fs}px system-ui, sans-serif`;
  const tw = Math.min(W * 0.92, Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2);
  c.width = Math.ceil(tw); c.height = lh * lines.length + pad * 2;
  g.font = `700 ${fs}px system-ui, sans-serif`;
  g.fillStyle = 'rgba(0,0,0,0.62)';
  if (g.roundRect) { g.beginPath(); g.roundRect(0, 0, c.width, c.height, fs * 0.4); g.fill(); } else g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 4;
  lines.forEach((l, i) => g.fillText(l, c.width / 2, pad + lh * i + lh / 2));
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return { data: new Uint8Array(await blob.arrayBuffer()), w: c.width, h: c.height };
}

function silentWav(sec, rate = 22050) {
  const n = Math.round(sec * rate), buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  return new Blob([buf], { type: 'audio/wav' });
}

function srtTime(t) { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; }

const KB = [
  { z: "1+0.16*on/F", x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" },
  { z: "1.16-0.16*on/F", x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" },
  { z: "1.14", x: "(iw-iw/zoom)*on/F", y: "ih/2-(ih/zoom/2)" },
  { z: "1+0.12*on/F", x: "(iw-iw/zoom)*(1-on/F)", y: "ih/2-(ih/zoom/2)" },
  { z: "1.14", x: "iw/2-(iw/zoom/2)", y: "(ih-ih/zoom)*(1-on/F)" },
];

export async function getFFmpeg(log) {
  if (ff && ff.loaded) return ff;
  ff = new FFmpeg();
  ff.on('log', ({ message }) => log?.(message));
  const base = new URL('ffmpeg/', document.baseURI).href;
  await ff.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
  return ff;
}

// ---------- montagem ----------
async function render() {
  if (!scenes.length) return toast('Gere o roteiro primeiro');
  const fmt = $('#vidFormat').value, res = Number($('#vidRes').value);
  const W = fmt === '16:9' ? Math.round((res * 16) / 9 / 2) * 2 : res, H = fmt === '16:9' ? res : Math.round((res * 16) / 9 / 2) * 2;
  const FPS = 24, LEAD = 0.3, TAIL = 0.45, FADE = 0.35;
  const subsOn = $('#vidSubs').checked, voice = $('#vidVoice').value, style = $('#vidStyle').value;
  const title = $('#vidTitle').value.trim() || 'video';
  const prog = $('#vidProgress'), logEl = $('#vidLog');
  const btnR = $('#btnRender'), btnC = $('#btnCancelVid');
  btnR.disabled = true; $('#btnScript').disabled = true; btnC.hidden = false; logEl.hidden = false; logEl.textContent = '';
  $('#vidResult').innerHTML = '';
  abort = new AbortController();
  const signal = abort.signal;
  const log = (m) => { logEl.textContent = (logEl.textContent + m + '\n').slice(-4000); logEl.scrollTop = logEl.scrollHeight; };
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  const clips = []; const srt = []; let tOffset = 0; let warnVoice = false, warnImg = 0;
  const N = scenes.length;
  const stepP = (i, f, txt) => setProgress(prog, (i + f) / (N + 1), txt);
  try {
    stepP(0, 0, 'Carregando o editor de vídeo (~30 MB, só na 1ª vez)…');
    const ffm = await getFFmpeg((m) => { if (/error|Error|Invalid|failed/i.test(m)) log('ffmpeg: ' + m); });
    const srcMode = $('#vidImgSrc').value; const credits = [];
    const iw = fmt === '16:9' ? 1280 : 720, ih = fmt === '16:9' ? 720 : 1280;
    const photo = async (i) => { const r = await fetchStockPhoto(scenes[i].busca || scenes[i].imagem, iw, { signal, skip: i % 3 }); if (r.credit) credits.push(`Cena ${i + 1}: ${r.credit}`); return r.blob; };
    const useAI = srcMode === 'ai' || (srcMode === 'auto' && hasImageKey());
    if (srcMode === 'ai' && !hasImageKey()) log('Imagens IA no vídeo precisam da chave Pollinations (Ajustes). Usando fotos reais.');
    const img = async (i) => {
      const prompt = `${scenes[i].imagem}, ${style}, no text`, seed = 1000 + i * 31 + Math.floor(Math.random() * 1e6);
      if (useAI && hasImageKey()) {
        try { return await fetchImage(prompt, iw, ih, seed, { signal }); }
        catch (e) { if (e.name === 'AbortError') throw e; log(`cena ${i + 1}: imagem IA falhou (${e.message}), tentando foto real`); }
      }
      try { return await photo(i); }
      catch (e) { if (e.name === 'AbortError') throw e; warnImg++; log(`cena ${i + 1}: sem imagem (${e.message}), usando fundo`); return null; }
    };
    let nextImg = img(0);
    for (let i = 0; i < N; i++) {
      if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      const sc = scenes[i];
      stepP(i, 0.05, `Cena ${i + 1}/${N}: imagem…`);
      const imgBlob = await nextImg;
      await sleep(400);
      nextImg = i + 1 < N ? img(i + 1) : null; // pré-carrega a próxima enquanto processa esta
      const jpg = await coverJPEG(imgBlob, Math.round(W * 1.25), Math.round(H * 1.25));

      stepP(i, 0.25, `Cena ${i + 1}/${N}: narração…`);
      let wav, dur, pieces, gap = 0.25;
      try {
        const r = await synthPiper(sc.narracao, voice, { signal, onProgress: (f, t) => stepP(i, 0.25 + 0.2 * f, `Cena ${i + 1}/${N}: ${t}`) });
        wav = r.blob; dur = r.duration; pieces = r.pieces; gap = r.gap;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (!warnVoice) log('Narração indisponível (' + e.message + '). Seguindo sem voz, só com legendas.');
        warnVoice = true;
        const words = sc.narracao.split(/\s+/).length; dur = Math.max(3, words / 2.5);
        wav = silentWav(dur); pieces = [{ text: sc.narracao, duration: dur }];
      }
      const D = LEAD + dur + TAIL, F = Math.ceil(D * FPS);
      const { caps, fs } = buildCaptions(pieces, gap, LEAD, W, H);
      caps.forEach((c) => srt.push({ ...c, start: c.start + tOffset, end: c.end + tOffset }));

      stepP(i, 0.5, `Cena ${i + 1}/${N}: montando…`);
      await ffm.writeFile('img.jpg', new Uint8Array(await jpg.arrayBuffer()));
      await ffm.writeFile('a.wav', new Uint8Array(await wav.arrayBuffer()));
      const inputs = ['-i', 'img.jpg', '-i', 'a.wav'];
      const kb = KB[i % KB.length];
      const ex = (e) => e.replace(/F/g, String(F));
      let fc = `[0:v]zoompan=z='${ex(kb.z)}':x='${ex(kb.x)}':y='${ex(kb.y)}':d=${F}:s=${W}x${H}:fps=${FPS},setsar=1[v0]`;
      let last = 'v0';
      if (subsOn) {
        for (let k = 0; k < caps.length; k++) {
          const png = await captionPNG(caps[k].lines, fs, W);
          await ffm.writeFile(`s${k}.png`, png.data);
          inputs.push('-i', `s${k}.png`);
          const x = Math.round((W - png.w) / 2), y = Math.round(H - png.h - H * (W > H ? 0.07 : 0.16));
          fc += `;[${last}][${k + 2}:v]overlay=x=${x}:y=${y}:enable='between(t,${caps[k].start.toFixed(2)},${caps[k].end.toFixed(2)})'[v${k + 1}]`;
          last = `v${k + 1}`;
        }
      }
      fc += `;[${last}]format=yuv420p,fade=t=in:st=0:d=${FADE},fade=t=out:st=${(D - FADE).toFixed(2)}:d=${FADE}[vout]`;
      fc += `;[1:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad,atrim=0:${D.toFixed(2)},afade=t=out:st=${(D - 0.25).toFixed(2)}:d=0.25[aout]`;
      const onP = ({ progress }) => { if (progress > 0 && progress <= 1) stepP(i, 0.5 + 0.5 * progress, `Cena ${i + 1}/${N}: codificando ${Math.round(progress * 100)}%`); };
      ffm.on('progress', onP);
      const code = await ffm.exec([...inputs, '-filter_complex', fc, '-map', '[vout]', '-map', '[aout]', '-t', D.toFixed(2), '-r', String(FPS),
        '-c:v', 'libx264', '-preset', 'superfast', '-crf', res >= 720 ? '28' : '28', '-g', String(FPS * 4), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-video_track_timescale', '12288', '-y', 'clip.mp4']);
      ffm.off('progress', onP);
      if (code !== 0) throw new Error(`Falha ao montar a cena ${i + 1} (ffmpeg ${code}). Veja o registro.`);
      const data = await ffm.readFile('clip.mp4');
      clips.push(new Blob([data.buffer], { type: 'video/mp4' }));
      for (const f of ['img.jpg', 'a.wav', 'clip.mp4', ...caps.map((_, k) => `s${k}.png`)]) { try { await ffm.deleteFile(f); } catch {} }
      tOffset += D;
      log(`cena ${i + 1}/${N} ok (${D.toFixed(1)} s)`);
    }

    // juntar tudo
    stepP(N, 0.1, 'Juntando as cenas no vídeo final…');
    const names = clips.map((_, i) => `c${String(i).padStart(3, '0')}.mp4`);
    let mounted = false;
    try {
      try { await ff.createDir('/clips'); } catch {}
      await ff.mount(FFFSType.WORKERFS, { blobs: clips.map((b, i) => ({ name: names[i], data: b })) }, '/clips');
      mounted = true;
    } catch (e) {
      log('WORKERFS indisponível, usando memória: ' + e.message);
      for (let i = 0; i < clips.length; i++) await ff.writeFile(`/clips/${names[i]}`, new Uint8Array(await clips[i].arrayBuffer()));
    }
    await ff.writeFile('list.txt', names.map((n) => `file '/clips/${n}'`).join('\n'));
    const code = await ff.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', '-y', 'final.mp4']);
    if (code !== 0) throw new Error('Falha ao juntar as cenas (ffmpeg ' + code + ')');
    const out = await ff.readFile('final.mp4');
    const final = new Blob([out.buffer], { type: 'video/mp4' });
    try { await ff.deleteFile('final.mp4'); await ff.deleteFile('list.txt'); if (mounted) await ff.unmount('/clips'); else for (const n of names) await ff.deleteFile('/clips/' + n); } catch {}

    setProgress(prog, 1, `Vídeo pronto! ${Math.floor(tOffset / 60)}min ${Math.round(tOffset % 60)}s · ${(final.size / 1048576).toFixed(1)} MB`);
    const safe = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').slice(0, 50).toLowerCase() || 'video';
    const srtTxt = srt.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join('\n')}\n`).join('\n');
    const scriptTxt = `${title}\n\n` + scenes.map((s, i) => `Cena ${i + 1}: ${s.narracao}`).join('\n\n');
    const box = $('#vidResult');
    const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.src = URL.createObjectURL(final);
    const row = document.createElement('div'); row.className = 'row wrap';
    const mk = (t, fn, cls = 'btn') => { const b = document.createElement('button'); b.className = cls; b.textContent = t; b.onclick = fn; row.appendChild(b); };
    mk('⬇ Baixar MP4', () => downloadBlob(final, safe + '.mp4'), 'btn primary grow');
    mk('Legendas .srt', () => downloadBlob(new Blob([srtTxt], { type: 'text/plain' }), safe + '.srt'), 'btn ghost');
    mk('Roteiro .txt', () => downloadBlob(new Blob([scriptTxt], { type: 'text/plain' }), safe + '.txt'), 'btn ghost');
    if (credits.length) mk('Créditos das fotos', () => downloadBlob(new Blob(['Fotos: Wikimedia Commons (licenças livres; confira cada link para a atribuição exigida)\n\n' + credits.join('\n')], { type: 'text/plain' }), safe + '-creditos.txt'), 'btn ghost');
    if (navigator.canShare?.({ files: [new File([final], safe + '.mp4', { type: 'video/mp4' })] })) mk('Compartilhar', () => navigator.share({ files: [new File([final], safe + '.mp4', { type: 'video/mp4' })], title }).catch(() => {}), 'btn ghost');
    box.append(v, row);
    if (warnVoice) log('Aviso: a narração Piper não funcionou neste aparelho; o vídeo saiu sem voz.');
    if (warnImg) log(`Aviso: ${warnImg} imagem(ns) falharam e viraram fundo colorido.`);
    toast('Vídeo pronto! 🎬');
  } catch (e) {
    if (e.name === 'AbortError' || signal.aborted) { setProgress(prog, 0, 'Cancelado'); }
    else { console.error(e); setProgress(prog, 0, 'Erro: ' + e.message); log('ERRO: ' + e.message); toast(e.message); }
  } finally {
    btnR.disabled = false; $('#btnScript').disabled = false; btnC.hidden = true; abort = null;
    try { await wake?.release(); } catch {}
  }
}

function cancel() {
  abort?.abort();
  if (ff) { try { ff.terminate(); } catch {} ff = null; }
}

export function initVideo() {
  $('#btnScript').onclick = genScript;
  $('#btnRender').onclick = render;
  $('#btnCancelVid').onclick = cancel;
  $('#btnAddScene').onclick = () => { scenes.push({ narracao: '', imagem: '', busca: '' }); renderScenes(); };
}
