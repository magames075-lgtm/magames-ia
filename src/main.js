import './style.css';
import { settings, saveSettings, toast, setProgress, DEFAULT_PERSONA, downloadBlob } from './store.js';
import { initChat, exportChats, wipeChats } from './chat.js';
import { initImages } from './images.js';
import { initVideo } from './video.js';
import { getVoices, ttsBlob, stopQuick } from './voice.js';
import { wake, onServerState, startKeepAlive, friendly } from './api.js';

const $ = (s) => document.querySelector(s);
const APP_VERSION = '2.0.0';

// ---------- tema ----------
function applyTheme() {
  const t = settings.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'light' ? '#f6f5ff' : '#0b0a18';
}
applyTheme();

// ---------- navegação ----------
function show(view) {
  if (!document.getElementById('view-' + view)) view = 'chat';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#btnMenu').style.visibility = view === 'chat' ? 'visible' : 'hidden';
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => show(b.dataset.view)));

// ---------- estado do servidor ----------
const banner = $('#serverBanner');
onServerState((s) => {
  const pill = $('#backendPill');
  if (s === 'waking') { banner.hidden = false; banner.className = 'banner warn'; banner.innerHTML = '<span class="spinner"></span> Acordando o servidor grátis… (até ~50 s na primeira vez)'; pill.textContent = 'acordando'; }
  else if (s === 'down') { banner.hidden = false; banner.className = 'banner err'; banner.innerHTML = 'Servidor fora do ar ou sem internet. <button id="btnRetryWake" class="btn small">Tentar de novo</button>'; $('#btnRetryWake').onclick = () => wake().catch(() => {}); pill.textContent = 'offline'; }
  else if (s === 'ok') { banner.hidden = true; pill.textContent = 'online'; pill.classList.add('ok'); }
});
wake().catch(() => {});
startKeepAlive();

// ---------- voz ----------
let VOICES = [];
async function fillVoices() {
  VOICES = await getVoices();
  for (const sel of [$('#ttsVoice'), $('#vidVoice'), $('#setVoice')]) {
    const prev = sel.id === 'vidVoice' ? (settings.videoVoice || 'pt-BR-AntonioNeural') : settings.voice;
    sel.innerHTML = '';
    VOICES.forEach((v) => sel.add(new Option(`${v.name} — ${v.desc}`, v.id)));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
}
fillVoices();
$('#ttsVoice').onchange = () => { settings.voice = $('#ttsVoice').value; $('#setVoice').value = settings.voice; saveSettings(); };
$('#setVoice').onchange = () => { settings.voice = $('#setVoice').value; $('#ttsVoice').value = settings.voice; saveSettings(); };
$('#vidVoice').onchange = () => { settings.videoVoice = $('#vidVoice').value; saveSettings(); };
$('#ttsText').oninput = () => { $('#ttsCount').textContent = $('#ttsText').value.length + ' / 12000'; };

let preview = null;
async function playPreview(voice, btn) {
  stopQuick(); preview?.pause();
  const old = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try {
    const b = await ttsBlob('Olá! Eu sou uma voz da MaGames IA. Posso narrar seus vídeos, textos e histórias.', voice);
    preview = new Audio(URL.createObjectURL(b)); await preview.play();
  } catch (e) { toast('Prévia: ' + friendly(e)); }
  finally { btn.disabled = false; btn.textContent = old; }
}
$('#btnPreviewVoice').onclick = (e) => playPreview($('#ttsVoice').value, e.currentTarget);
$('#btnPreviewVidVoice').onclick = (e) => playPreview($('#vidVoice').value, e.currentTarget);

let ttsAbort = null;
$('#btnTts').onclick = async () => {
  const text = $('#ttsText').value.trim();
  if (!text) return toast('Escreva um texto primeiro');
  const prog = $('#ttsProgress'), out = $('#ttsResult');
  const btn = $('#btnTts'); btn.disabled = true; out.innerHTML = '';
  ttsAbort = new AbortController();
  setProgress(prog, 0.3, 'Gerando voz neural no servidor…');
  try {
    const voice = $('#ttsVoice').value;
    const blob = await ttsBlob(text, voice, Number($('#ttsRate').value), { signal: ttsAbort.signal });
    const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(blob);
    const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = `⬇ Baixar MP3 (${Math.round(blob.size / 1024)} KB)`;
    b.onclick = () => downloadBlob(blob, 'magames-ia-voz.mp3');
    out.append(a, b); a.play().catch(() => {});
    setProgress(prog, 1, 'Pronto ✓');
  } catch (e) {
    if (e.name !== 'AbortError') { setProgress(prog, 0, 'Erro: ' + friendly(e)); toast('Voz: ' + friendly(e), 6000); }
  } finally { btn.disabled = false; ttsAbort = null; }
};
$('#btnTtsStop').onclick = () => { ttsAbort?.abort(); stopQuick(); preview?.pause(); document.querySelectorAll('#ttsResult audio').forEach((a) => a.pause()); };

// ---------- ajustes ----------
$('#setPersona').value = settings.persona;
$('#btnSavePersona').onclick = () => { settings.persona = $('#setPersona').value.trim() || DEFAULT_PERSONA; saveSettings(); toast('Personalidade salva'); };
$('#btnResetPersona').onclick = () => { settings.persona = DEFAULT_PERSONA; $('#setPersona').value = DEFAULT_PERSONA; saveSettings(); };
$('#setTheme').value = settings.theme;
$('#setTheme').onchange = () => { settings.theme = $('#setTheme').value; saveSettings(); applyTheme(); };
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
$('#btnExport').onclick = exportChats;
$('#btnWipe').onclick = async () => {
  if (!confirm('Apagar conversas, galeria e ajustes deste aparelho?')) return;
  wipeChats(); Object.keys(localStorage).filter((k) => k.startsWith('mgia.')).forEach((k) => localStorage.removeItem(k));
  try { indexedDB.deleteDatabase('mgia'); } catch {}
  toast('Tudo apagado'); setTimeout(() => location.reload(), 800);
};
$('#appVersion').textContent = APP_VERSION;

// ---------- PWA + atualização ----------
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
$('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const ask = (w) => {
      const bar = $('#updateBar'); bar.hidden = false;
      $('#btnUpdate').onclick = () => w.postMessage('skipWaiting');
    };
    if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

window.addEventListener('hashchange', () => show(location.hash.slice(1)));
initChat();
initImages();
initVideo();
show((location.hash || '#chat').slice(1).replace(/[^a-z]/g, '') || 'chat');
window.__mgia = { ready: true, version: APP_VERSION };
