// Estúdio de vídeo: roteiro (IA no servidor) → render no servidor (narração neural, imagens, Ken Burns, legendas) → MP4.
import { apiJSON, apiFetch, API, friendly } from './api.js';
import { toast, setProgress, load, save, sleep } from './store.js';

const $ = (s) => document.querySelector(s);
let scenes = [];
let polling = null;

function estimate() {
  const words = scenes.reduce((s, c) => s + (c.narration || '').split(/\s+/).filter(Boolean).length, 0);
  return { words, min: Math.round((words / 150) * 10) / 10 };
}

function renderScenes() {
  const box = $('#scenes'); box.innerHTML = '';
  const { words, min } = estimate();
  const est = document.createElement('p'); est.className = 'hint';
  est.textContent = `${scenes.length} cenas · ~${words} palavras · narração de ~${min} min`;
  box.appendChild(est);
  scenes.forEach((sc, i) => {
    const d = document.createElement('div'); d.className = 'scene';
    d.innerHTML = `<div class="scene-head"><b>Cena ${i + 1}</b><span><button type="button" title="Subir">↑</button><button type="button" title="Apagar">🗑</button></span></div>`;
    const ta = document.createElement('textarea'); ta.rows = 3; ta.value = sc.narration; ta.oninput = () => { sc.narration = ta.value; };
    const ip = document.createElement('input'); ip.value = sc.image; ip.placeholder = 'Descrição da imagem (inglês)'; ip.oninput = () => (sc.image = ip.value);
    const [up, del] = d.querySelectorAll('.scene-head button');
    up.onclick = () => { if (i > 0) { [scenes[i - 1], scenes[i]] = [scenes[i], scenes[i - 1]]; renderScenes(); } };
    del.onclick = () => { scenes.splice(i, 1); renderScenes(); };
    d.append(ta, ip); box.appendChild(d);
  });
}

async function genScript() {
  const topic = $('#vidTopic').value.trim();
  if (!topic) return toast('Escreva o tema do vídeo');
  const btn = $('#btnScript'); btn.disabled = true;
  const prog = $('#vidProgress');
  setProgress(prog, 0.15, 'Escrevendo o roteiro com IA… (pode levar até 1 min)');
  try {
    const s = await apiJSON('/api/script', { topic, minutes: Number($('#vidMinutes').value), tone: $('#vidTone').value });
    scenes = s.scenes; $('#vidTitle').value = s.title || topic;
    renderScenes(); $('#scriptBox').hidden = false;
    setProgress(prog, 1, `Roteiro pronto: ${scenes.length} cenas. Revise se quiser e toque em “Criar vídeo”.`);
  } catch (e) {
    setProgress(prog, 0, 'Erro: ' + friendly(e)); toast(friendly(e), 6000);
  } finally { btn.disabled = false; }
}

function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'; }

function showResult(job) {
  const out = $('#vidResult'); out.innerHTML = '';
  const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.preload = 'metadata';
  v.src = `${API}/api/video/${job.id}/file`;
  const a = document.createElement('a'); a.className = 'btn primary'; a.href = `${API}/api/video/${job.id}/file?dl=1`;
  a.textContent = `⬇ Baixar MP4 (${Math.round(job.duration)} s · ${fmtSize(job.size)})`; a.setAttribute('download', '');
  const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'O arquivo fica disponível no servidor por cerca de 1 hora. Baixe para guardar.';
  out.append(v, a, p);
}

async function poll(id) {
  const prog = $('#vidProgress'), log = $('#vidLog'), cancel = $('#btnCancelVid');
  cancel.hidden = false;
  const t0 = Date.now();
  polling = id;
  let fails = 0;
  while (polling === id) {
    try {
      const j = await apiJSON('/api/video/' + id);
      fails = 0;
      if (j.status === 'queued') setProgress(prog, 0.01, `Na fila (posição ${j.position})…`);
      else {
        const el = (Date.now() - t0) / 1000;
        const eta = j.progress > 0.08 ? Math.max(0, Math.round((el * (1 - j.progress)) / j.progress / 60)) : null;
        setProgress(prog, j.progress, `${Math.round(j.progress * 100)}% — ${j.stage} · ${Math.floor(el / 60)} min` + (eta !== null ? ` · falta ~${eta || '<1'} min` : ''));
      }
      log.hidden = false; log.textContent = (j.log || []).slice(-8).join('\n');
      if (j.status === 'done') { setProgress(prog, 1, 'Vídeo pronto ✓'); showResult(j); toast('Vídeo pronto!'); break; }
      if (j.status === 'error') { setProgress(prog, 0, 'Erro: ' + j.error); toast('O vídeo falhou: ' + j.error, 8000); break; }
      if (j.status === 'canceled') { setProgress(prog, 0, 'Cancelado'); break; }
    } catch (e) {
      if (e.status === 404) { setProgress(prog, 0, friendly(e)); break; }
      if (++fails > 20) { setProgress(prog, 0, 'Perdi contato com o servidor: ' + friendly(e)); break; }
    }
    await sleep(4000);
  }
  if (polling === id) polling = null;
  cancel.hidden = true; $('#btnRender').disabled = false;
  save('videoJob', null);
}

async function render() {
  scenes = scenes.filter((s) => s.narration.trim());
  if (!scenes.length) return toast('O roteiro está vazio');
  const btn = $('#btnRender'); btn.disabled = true;
  $('#vidResult').innerHTML = '';
  const prog = $('#vidProgress');
  setProgress(prog, 0.01, 'Enviando para o estúdio…');
  try {
    const body = {
      title: $('#vidTitle').value.trim(), scenes, aspect: $('#vidFormat').value, res: $('#vidRes').value,
      voice: $('#vidVoice').value, images: $('#vidImgSrc').value, subtitles: $('#vidSubs').checked, music: $('#vidMusic').checked,
    };
    const j = await apiJSON('/api/video', body);
    save('videoJob', j.id);
    poll(j.id);
  } catch (e) { btn.disabled = false; setProgress(prog, 0, 'Erro: ' + friendly(e)); toast(friendly(e), 6000); }
}

export function initVideo() {
  $('#btnScript').onclick = genScript;
  $('#btnRender').onclick = render;
  $('#btnAddScene').onclick = () => { scenes.push({ narration: '', image: '', query: '' }); renderScenes(); };
  $('#btnCancelVid').onclick = async () => {
    const id = polling; if (!id) return;
    try { await apiFetch('/api/video/' + id, { method: 'DELETE' }); } catch {}
    polling = null; setProgress($('#vidProgress'), 0, 'Cancelado'); $('#btnCancelVid').hidden = true; $('#btnRender').disabled = false; save('videoJob', null);
  };
  const pending = load('videoJob', null);
  if (pending) { $('#btnRender').disabled = true; poll(pending); }
}
