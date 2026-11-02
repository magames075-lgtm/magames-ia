import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import php from 'highlight.js/lib/languages/php';
import 'highlight.js/styles/atom-one-dark.css';
import { settings, load, save, toast, uid, downloadBlob } from './store.js';
import { chat as llmChat, PROVIDER_NAMES } from './llm.js';
import { speakQuick, stopQuick } from './voice.js';
import { apiFetch, friendly } from './api.js';

Object.entries({ javascript, typescript, python, java, kotlin, bash, json, css, xml, html: xml, sql, cpp, csharp, php }).forEach(([k, v]) => hljs.registerLanguage(k, v));
marked.setOptions({ gfm: true, breaks: true });

const $ = (s) => document.querySelector(s);
let chats = load('chats', []);
let currentId = load('current', null);
let busy = null; // AbortController

function cur() { return chats.find((c) => c.id === currentId); }
function persist() { chats.sort((a, b) => b.updated - a.updated); save('chats', chats.slice(0, 80)); save('current', currentId); }

export function renderMarkdown(md) {
  const html = DOMPurify.sanitize(marked.parse(md || ''), { ADD_ATTR: ['target'] });
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('pre code').forEach((el) => {
    try { hljs.highlightElement(el); } catch {}
    const btn = document.createElement('button');
    btn.className = 'copy'; btn.type = 'button'; btn.textContent = 'copiar';
    btn.onclick = () => { navigator.clipboard?.writeText(el.innerText); btn.textContent = 'copiado!'; setTimeout(() => (btn.textContent = 'copiar'), 1500); };
    el.parentElement.appendChild(btn);
  });
  div.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  return div;
}

function welcome() {
  const w = document.createElement('div');
  w.className = 'welcome';
  w.innerHTML = `<img src="./icons/icon-192.png" width="64" height="64" style="border-radius:18px" alt="" /><h1>Olá! Eu sou a MaGames IA</h1>
  <p>Chat, imagens, voz e vídeos — grátis e sem login.</p><div class="chips"></div>`;
  const ideas = ['Crie um roteiro de vídeo sobre curiosidades do espaço', 'Explique Kotlin coroutines com exemplo', 'Ideias de nomes para uma loja de achadinhos', 'Escreva uma legenda viral para Reels', 'Monte um plano de estudos de Python em 30 dias'];
  ideas.forEach((t) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => send(t); w.querySelector('.chips').appendChild(b); });
  return w;
}

function msgEl(m, idx) {
  const row = document.createElement('div');
  row.className = 'msg ' + m.role;
  const bub = document.createElement('div');
  bub.className = 'bubble';
  if (m.role === 'user') bub.textContent = m.content;
  else bub.appendChild(renderMarkdown(m.content));
  row.appendChild(bub);
  if (m.role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span>${PROVIDER_NAMES[m.provider] || ''}</span>`;
    const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = fn; meta.appendChild(b); };
    mk('copiar', () => { navigator.clipboard?.writeText(m.content); toast('Copiado'); });
    mk('🔊 ouvir', () => { toast('Gerando voz…'); speakQuick(m.content, settings.voice).catch((e) => toast('Voz: ' + e.message)); });
    mk('■', () => stopQuick());
    if (idx === cur()?.messages.length - 1) mk('↻ refazer', regenerate);
    bub.appendChild(meta);
  }
  return row;
}

export function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const c = cur();
  if (!c || !c.messages.length) { box.appendChild(welcome()); return; }
  c.messages.forEach((m, i) => box.appendChild(msgEl(m, i)));
  box.scrollTop = box.scrollHeight;
}

export function renderList() {
  const ul = $('#chatList');
  ul.innerHTML = '';
  chats.forEach((c) => {
    const li = document.createElement('li');
    if (c.id === currentId) li.className = 'active';
    const s = document.createElement('span'); s.textContent = c.title || 'Nova conversa';
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Apagar';
    del.onclick = (e) => { e.stopPropagation(); if (!confirm('Apagar esta conversa?')) return; chats = chats.filter((x) => x.id !== c.id); if (currentId === c.id) currentId = chats[0]?.id || null; persist(); renderList(); renderMessages(); };
    li.append(s, del);
    li.onclick = () => { currentId = c.id; persist(); renderList(); renderMessages(); closeDrawer(); };
    ul.appendChild(li);
  });
}

function newChat() { const c = { id: uid(), title: '', messages: [], updated: Date.now() }; chats.unshift(c); currentId = c.id; persist(); renderList(); renderMessages(); return c; }

function setBusy(on) {
  const b = $('#btnSend');
  b.classList.toggle('stop', on); b.textContent = on ? '■' : '➤'; b.setAttribute('aria-label', on ? 'Parar' : 'Enviar');
}

async function runAssistant(c) {
  const box = $('#messages');
  const row = document.createElement('div'); row.className = 'msg assistant';
  const bub = document.createElement('div'); bub.className = 'bubble';
  bub.innerHTML = '<span class="thinking">pensando<span class="dots"></span></span>';
  row.appendChild(bub); box.appendChild(row); box.scrollTop = box.scrollHeight;

  const history = c.messages.filter((m) => !m.error).slice(-24).map(({ role, content }) => ({ role, content }));
  const messages = [{ role: 'system', content: settings.persona }, ...history];
  let text = '', provider = '', raf = 0;
  const paint = () => { raf = 0; bub.innerHTML = ''; bub.appendChild(renderMarkdown(text)); const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160; if (near) box.scrollTop = box.scrollHeight; };
  busy = new AbortController(); setBusy(true);
  try {
    const r = await llmChat(messages, {
      signal: busy.signal,
      onProvider: (p) => { provider = p;  },
      onToken: (t) => { text += t; if (!raf) raf = requestAnimationFrame(paint); },
    });
    provider = r.provider;
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (!text) { c.messages.push({ role: 'assistant', content: `⚠️ **Não consegui responder agora.** ${friendly(e)}\n\nToque em **↻ refazer** para tentar de novo.`, provider: '', error: true }); c.updated = Date.now(); persist(); renderMessages(); busy = null; setBusy(false); return; }
    }
  } finally { busy = null; setBusy(false); }
  if (!text) text = '_(cancelado)_';
  c.messages.push({ role: 'assistant', content: text, provider });
  c.updated = Date.now(); persist(); renderMessages();
}

async function makeTitle(c, firstMsg) {
  c.title = firstMsg.slice(0, 48) + (firstMsg.length > 48 ? '…' : '');
  persist(); renderList();
}

export async function send(textArg) {
  if (busy) { busy.abort(); return; }
  const input = $('#input');
  const text = (textArg ?? input.value).trim();
  if (!text) return;
  input.value = ''; autosize();
  let c = cur() || newChat();
  c.messages.push({ role: 'user', content: text });
  c.updated = Date.now();
  if (!c.title) makeTitle(c, text);
  persist(); renderMessages();
  await runAssistant(c);
}

async function regenerate() {
  const c = cur(); if (!c || busy) return;
  if (c.messages[c.messages.length - 1]?.role === 'assistant') c.messages.pop();
  renderMessages(); await runAssistant(c);
}

function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }
function closeDrawer() { $('#drawer').classList.remove('open'); }

// ---------- voz para texto (Web Speech API) ----------
let rec = null;
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#btnMic');
  if (!SR) return recordWhisper(btn);
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = false;
  const base = $('#input').value ? $('#input').value + ' ' : '';
  rec.onresult = (e) => { let t = ''; for (const r of e.results) t += r[0].transcript; $('#input').value = base + t; autosize(); };
  rec.onerror = (e) => { if (e.error === 'network' || e.error === 'service-not-allowed') { rec = null; btn.classList.remove('rec'); recordWhisper(btn); } else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Microfone: ' + e.error); };
  rec.onend = () => { rec = null; btn.classList.remove('rec'); };
  rec.start(); btn.classList.add('rec');
}

// reserva: grava e transcreve no servidor (Whisper via Groq, grátis)
let mr = null;
async function recordWhisper(btn) {
  if (mr) { mr.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Este navegador não permite gravar áudio.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Permita o microfone para falar.'); }
  const chunks = [];
  mr = new MediaRecorder(stream);
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop()); btn.classList.remove('rec'); mr = null;
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    if (blob.size < 2000) return;
    toast('Transcrevendo…');
    try {
      const fd = new FormData(); fd.append('file', blob, 'fala.webm'); fd.append('language', 'pt');
      const r = await apiFetch('/api/stt', { method: 'POST', body: fd });
      const { text } = await r.json();
      const inp = $('#input'); inp.value = (inp.value ? inp.value + ' ' : '') + text; autosize(); inp.focus();
    } catch (e) { toast('Transcrição: ' + friendly(e)); }
  };
  mr.start(); btn.classList.add('rec'); toast('Gravando… toque de novo para parar');
}

export function exportChats() { downloadBlob(new Blob([JSON.stringify(chats, null, 2)], { type: 'application/json' }), 'magames-ia-conversas.json'); }
export function wipeChats() { chats = []; currentId = null; persist(); renderList(); renderMessages(); }

export function initChat() {
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#input').addEventListener('input', autosize);
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send(); } });
  $('#btnMic').onclick = toggleMic;
  $('#btnNewChat').onclick = () => { newChat(); closeDrawer(); };
  $('#btnMenu').onclick = () => $('#drawer').classList.toggle('open');
  $('#drawerScrim').onclick = closeDrawer;
  if (!cur()) currentId = chats[0]?.id || null;
  renderList(); renderMessages();
}
