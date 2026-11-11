'use strict';
/* Command AI — MaGames Tecnologia */
const $ = (id) => document.getElementById(id);
const LS = { cfg: 'cmdai.cfg', hist: 'cmdai.hist' };

const SYSTEM = `You are Command AI, an autonomous senior software engineer and architect.
The user gives ONE command. You work completely alone:
1. Analyze the command deeply and infer every unstated requirement a professional would expect (structure, error handling, validation, responsive UI, security, comments).
2. When web search is available, use it to check current documentation, APIs and library versions so the code works today.
3. Make every decision yourself. NEVER ask the user questions, never offer alternatives or "options", never stop halfway.
4. Deliver COMPLETE, working, production-ready code for EVERY file. Forbidden: TODO, placeholders, "..." , "rest of the code here", "implement this yourself", pseudo-code.
5. Prefer the simplest stack that fully solves the command. If the user named a language or framework, use it.

Output format (Markdown):
- First: a 2–4 line summary of what you built and the decisions you took.
- Then: "## Estrutura" with the file tree.
- Then every file as a heading "### path/to/file" followed by ONE fenced code block with the language tag and the full file content.
- Finally: "## Como rodar" with exact step-by-step commands.
Write explanations and code comments in the same language as the user's command (Portuguese if the command is in Portuguese).`;

const RESEARCH = `You are the research step of Command AI. Analyze the user's command, search the web for whatever is needed (current library versions, official docs, API endpoints, best practices) and output a compact technical brief (max 500 words): the interpreted requirements, the chosen stack with exact versions, key API details/snippets, pitfalls to avoid, and the list of files to create. Do not write the final code. Never ask questions.`;

const CONT = 'Continue EXACTLY where you stopped, without repeating anything already written and without any introduction. If you were inside a code block, continue inside it.';

let cfg = Object.assign({ prov: 'gemini', key: '', model: '' }, JSON.parse(localStorage.getItem(LS.cfg) || '{}'));
let ctrl = null;
let lastText = '';

/* ---------- UI helpers ---------- */
function toast(t) { const e = $('toast'); e.textContent = t; e.classList.remove('hidden'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.add('hidden'), 2200); }
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function step(text, state = 'on') {
  const d = document.createElement('div');
  d.className = 's ' + state;
  d.innerHTML = (state === 'on' ? '<span class="spin"></span>' : state === 'ok' ? '✔' : '✖') + '<span></span>';
  d.lastChild.textContent = text;
  $('steps').appendChild(d);
  return {
    set(t) { d.lastChild.textContent = t; },
    done(t, st = 'ok') { d.className = 's ' + st; d.firstChild.outerHTML = st === 'ok' ? '✔' : '✖'; if (t) d.lastChild.textContent = t; }
  };
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast('Copiado!');
}
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function render(md) {
  const out = $('out'); out.innerHTML = '';
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '', list = null, i = 0;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const blocks = [];
  while (i < lines.length) {
    const l = lines[i];
    const f = l.match(/^\s*```\s*([\w+#.-]*)/);
    if (f) {
      closeList();
      const lang = f[1] || 'code'; const buf = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(buf.join('\n'));
      html += `<div class="code"><div class="bar"><span>${esc(lang)}</span><button data-b="${blocks.length - 1}">Copiar</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { closeList(); const n = Math.min(m[1].length + 1, 3); html += `<h${n}>${inline(m[2])}</h${n}>`; }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>'; } html += `<li>${inline(m[1])}</li>`; }
    else if (l.trim() === '') closeList();
    else { closeList(); html += `<p>${inline(l)}</p>`; }
    i++;
  }
  closeList();
  out.innerHTML = html;
  out.querySelectorAll('button[data-b]').forEach(b => b.onclick = () => copy(blocks[+b.dataset.b]));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- HTTP with rate-limit waits ---------- */
async function post(url, headers, body, st) {
  for (let tries = 0; tries < 6; tries++) {
    const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body), signal: ctrl.signal });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch {}
    if (r.ok) return j;
    const msg = (j.error && (j.error.message || j.error.status)) || txt.slice(0, 300) || ('HTTP ' + r.status);
    if (r.status === 429 || r.status === 503 || (r.status === 413 && /rate|TPM|tokens per minute/i.test(msg))) {
      const m = msg.match(/try again in\s+(?:(\d+)m)?([\d.]+)s/i) || msg.match(/retry in\s+([\d.]+)s/i);
      let wait = 20;
      if (m) wait = m.length === 3 ? (+(m[1] || 0) * 60 + +m[2]) : +m[1];
      if (/per day|RPD|TPD|quota/i.test(msg) && wait > 120) throw new Error('Limite diário do provedor atingido. ' + msg);
      wait = Math.min(Math.ceil(wait) + 1, 90);
      for (let s = wait; s > 0; s--) { st && st.set(`Limite por minuto do provedor. Continuando em ${s}s…`); await sleep(1000); }
      continue;
    }
    if (r.status === 400 && /api key|API_KEY_INVALID/i.test(msg) || r.status === 401 || r.status === 403) throw new Error('Chave de API inválida ou sem permissão. Confira em Configurações. (' + msg + ')');
    const e = new Error(msg); e.status = r.status; throw e;
  }
  throw new Error('O provedor continuou ocupado. Tente de novo em alguns minutos.');
}

/* ---------- Gemini ---------- */
async function runGemini(cmd, deep) {
  const model = cfg.model || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const contents = [{ role: 'user', parts: [{ text: cmd }] }];
  let text = ''; const sources = new Map();
  for (let round = 0; round < 5; round++) {
    const st = step(round === 0 ? (deep ? 'Analisando o comando, pesquisando no Google e escrevendo o código…' : 'Analisando o comando e escrevendo o código…') : `Continuando a resposta (parte ${round + 1})…`);
    const t0 = Date.now(); const tick = setInterval(() => st.set((round === 0 ? 'Pensando e escrevendo' : `Parte ${round + 1}`) + ` · ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
    let j;
    try {
      const body = { systemInstruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig: { maxOutputTokens: 65536, temperature: 0.4 } };
      if (deep) body.tools = [{ google_search: {} }];
      j = await post(url, { 'x-goog-api-key': cfg.key }, body, st);
    } finally { clearInterval(tick); }
    const c = (j.candidates || [])[0];
    if (!c) { st.done('Sem resposta do Gemini', 'err'); throw new Error((j.promptFeedback && JSON.stringify(j.promptFeedback)) || 'Resposta vazia.'); }
    const part = (c.content && c.content.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
    text += part;
    ((c.groundingMetadata || {}).groundingChunks || []).forEach(g => g.web && sources.set(g.web.uri, g.web.title || g.web.uri));
    render(text);
    st.done(round === 0 ? 'Código gerado' : `Parte ${round + 1} recebida`);
    if (c.finishReason !== 'MAX_TOKENS') break;
    contents.push({ role: 'model', parts: [{ text: part }] }, { role: 'user', parts: [{ text: CONT }] });
  }
  if (sources.size) text += '\n\n## Fontes pesquisadas\n' + [...sources].slice(0, 12).map(([u, t]) => `- [${t}](${u})`).join('\n');
  return text;
}

/* ---------- Groq ---------- */
async function runGroq(cmd, deep) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const H = { Authorization: 'Bearer ' + cfg.key };
  let notes = '';
  if (deep) {
    const st = step('Analisando o comando e pesquisando na internet…');
    try {
      const j = await post(url, H, { model: 'groq/compound', messages: [{ role: 'system', content: RESEARCH }, { role: 'user', content: cmd }] }, st);
      notes = j.choices[0].message.content || '';
      st.done('Pesquisa concluída');
    } catch (e) {
      if (/inválida/.test(e.message)) { st.done('Falhou', 'err'); throw e; }
      try {
        const j = await post(url, H, { model: 'openai/gpt-oss-120b', tools: [{ type: 'browser_search' }], max_completion_tokens: 2500, messages: [{ role: 'system', content: RESEARCH }, { role: 'user', content: cmd }] }, st);
        notes = j.choices[0].message.content || '';
        st.done('Pesquisa concluída');
      } catch (e2) { st.done('Pesquisa indisponível, seguindo sem ela', 'err'); }
    }
    notes = notes.slice(0, 4000);
  }
  const model = cfg.model || 'openai/gpt-oss-120b';
  const userMsg = cmd + (notes ? '\n\n--- Research brief (use it) ---\n' + notes : '');
  let text = '';
  for (let round = 0; round < 10; round++) {
    const st = step(round === 0 ? 'Pensando e escrevendo o código completo…' : `Continuando (parte ${round + 1})…`);
    const t0 = Date.now(); const tick = setInterval(() => st.set((round === 0 ? 'Pensando e escrevendo' : `Parte ${round + 1}`) + ` · ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: round === 0 ? userMsg : cmd }];
    if (round > 0) messages.push({ role: 'assistant', content: '…' + text.slice(-2500) }, { role: 'user', content: CONT });
    const body = { model, messages, max_completion_tokens: 6000, temperature: 0.4 };
    if (/gpt-oss/.test(model)) body.reasoning_effort = 'medium';
    let j;
    try { j = await post(url, H, body, st); } finally { clearInterval(tick); }
    const ch = j.choices[0];
    text += ch.message.content || '';
    render(text);
    st.done(round === 0 ? 'Código gerado' : `Parte ${round + 1} recebida`);
    if (ch.finish_reason !== 'length') break;
  }
  return text;
}

/* ---------- Main ---------- */
async function generate() {
  const cmd = $('cmd').value.trim();
  if (!cmd) { toast('Escreva um comando'); return; }
  if (!cfg.key) { openCfg(); toast('Cole sua chave de API primeiro'); return; }
  $('steps').innerHTML = ''; $('out').innerHTML = ''; lastText = '';
  $('go').disabled = true; $('actions').classList.remove('hidden'); $('stop').classList.remove('hidden'); $('copyAll').classList.add('hidden');
  ctrl = new AbortController();
  try {
    lastText = cfg.prov === 'groq' ? await runGroq(cmd, $('deep').checked) : await runGemini(cmd, $('deep').checked);
    render(lastText);
    saveHist(cmd, lastText);
    step('Pronto! Código completo entregue.', 'ok');
  } catch (e) {
    if (e.name === 'AbortError') step('Parado por você.', 'err');
    else step('Erro: ' + e.message, 'err');
    if (lastText) render(lastText);
  } finally {
    $('go').disabled = false; $('stop').classList.add('hidden');
    if ($('out').textContent.trim()) { lastText = lastText || $('out').innerText; $('copyAll').classList.remove('hidden'); }
  }
}

/* ---------- History ---------- */
function getHist() { try { return JSON.parse(localStorage.getItem(LS.hist) || '[]'); } catch { return []; } }
function saveHist(cmd, text) {
  const h = getHist(); h.unshift({ cmd, text, at: new Date().toISOString() });
  try { localStorage.setItem(LS.hist, JSON.stringify(h.slice(0, 20))); } catch { localStorage.setItem(LS.hist, JSON.stringify(h.slice(0, 5))); }
}
function openHist() {
  const h = getHist(); const L = $('histList');
  L.innerHTML = h.length ? '' : '<p class="hint">Nada ainda.</p>';
  h.forEach((it) => {
    const d = document.createElement('div'); d.className = 'hi';
    d.innerHTML = `<div></div><small>${new Date(it.at).toLocaleString('pt-BR')}</small>`;
    d.firstChild.textContent = it.cmd.slice(0, 140);
    d.onclick = () => { $('cmd').value = it.cmd; lastText = it.text; $('steps').innerHTML = ''; render(it.text); $('actions').classList.remove('hidden'); $('copyAll').classList.remove('hidden'); $('hist').classList.add('hidden'); };
    L.appendChild(d);
  });
  $('hist').classList.remove('hidden');
}

/* ---------- Settings ---------- */
function keyHint() {
  $('keyHint').innerHTML = $('prov').value === 'groq'
    ? 'Chave grátis em <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>'
    : 'Chave grátis em <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>';
  $('model').placeholder = $('prov').value === 'groq' ? 'padrão: openai/gpt-oss-120b' : 'padrão: gemini-flash-latest';
}
function openCfg() { $('prov').value = cfg.prov; $('key').value = cfg.key; $('model').value = cfg.model; keyHint(); $('cfg').classList.remove('hidden'); }
$('prov').onchange = keyHint;
$('saveCfg').onclick = () => { cfg = { prov: $('prov').value, key: $('key').value.trim(), model: $('model').value.trim() }; localStorage.setItem(LS.cfg, JSON.stringify(cfg)); $('cfg').classList.add('hidden'); toast('Salvo'); };
$('closeCfg').onclick = () => $('cfg').classList.add('hidden');
$('btnCfg').onclick = openCfg;
$('btnHist').onclick = openHist;
$('closeHist').onclick = () => $('hist').classList.add('hidden');
$('clearHist').onclick = () => { localStorage.removeItem(LS.hist); openHist(); };
$('go').onclick = generate;
$('stop').onclick = () => ctrl && ctrl.abort();
$('copyAll').onclick = () => copy(lastText);
if (!cfg.key) setTimeout(openCfg, 300);
