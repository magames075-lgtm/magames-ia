import './style.css';
import { settings, saveSettings, toast, setProgress, DEFAULT_PERSONA } from './store.js';
import { initChat, exportChats, wipeChats } from './chat.js';
import { initImages } from './images.js';
import { initVideo } from './video.js';
import { PIPER_VOICES, systemVoices, synthPiper, speakSystem, stopSystem, piperStored, piperFlush, piperSession } from './voice.js';
import { hasWebGPU, loadOffline, deleteOffline, offlineCached, PROVIDER_NAMES } from './llm.js';
import { downloadBlob } from './store.js';

const $ = (s) => document.querySelector(s);

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

// ---------- vozes ----------
function fillVoices() {
  const sys = systemVoices();
  for (const sel of [$('#ttsVoice'), $('#vidVoice')]) {
    const isVid = sel.id === 'vidVoice';
    const prev = sel.value || (isVid ? 'pt_BR-faber-medium' : settings.voice);
    sel.innerHTML = '';
    PIPER_VOICES.forEach((v) => sel.add(new Option(v.label, isVid ? v.id : 'piper:' + v.id)));
    if (!isVid) sys.forEach((v) => sel.add(new Option(`${v.name} (sistema, ${v.lang})`, 'sys:' + v.name)));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
}
fillVoices();
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fillVoices;

let ttsAbort = null;
$('#ttsVoice').onchange = () => { settings.voice = $('#ttsVoice').value; saveSettings(); };
$('#btnTts').onclick = async () => {
  const text = $('#ttsText').value.trim();
  if (!text) return toast('Escreva um texto primeiro');
  const v = $('#ttsVoice').value, rate = Number($('#ttsRate').value);
  const prog = $('#ttsProgress'), out = $('#ttsResult');
  const btn = $('#btnTts'); btn.disabled = true; out.innerHTML = '';
  ttsAbort = new AbortController();
  try {
    if (v.startsWith('piper:')) {
      setProgress(prog, 0, 'Preparando voz neural…');
      const r = await synthPiper(text, v.slice(6), { signal: ttsAbort.signal, onProgress: (f, t) => setProgress(prog, f, t) });
      const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(r.blob);
      a.playbackRate = rate; a.preservesPitch = true; a.onloadedmetadata = () => (a.playbackRate = rate);
      const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = `⬇ Baixar áudio WAV (${Math.round(r.duration)} s)`;
      b.onclick = () => downloadBlob(r.blob, 'magames-ia-voz.wav');
      out.append(a, b); a.play().catch(() => {});
      setProgress(prog, 1, 'Pronto ✓');
    } else {
      prog.hidden = true;
      await speakSystem(text, v.slice(4), rate);
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.warn(e); toast('Voz neural falhou; usando a voz do sistema.');
      prog.hidden = true;
      try { await speakSystem(text, '', rate); } catch (e2) { toast('Sem voz disponível: ' + e2.message); }
    }
  } finally { btn.disabled = false; ttsAbort = null; }
};
$('#btnTtsStop').onclick = () => { ttsAbort?.abort(); stopSystem(); document.querySelectorAll('#ttsResult audio').forEach((a) => a.pause()); };

// ---------- ajustes ----------
function refreshPill() { $('#backendPill').textContent = settings.backend === 'auto' ? 'auto' : PROVIDER_NAMES[settings.backend]; }
$('#setBackend').value = settings.backend;
$('#setBackend').onchange = () => { settings.backend = $('#setBackend').value; saveSettings(); refreshPill(); if (settings.backend === 'offline' && !settings.offlineReady) toast('Baixe o modelo offline abaixo para usar este modo.'); };
refreshPill();
const keyFields = { keyGroq: ['keys', 'groq'], keyGemini: ['keys', 'gemini'], keyOpenrouter: ['keys', 'openrouter'], modelGroq: ['models', 'groq'], modelGemini: ['models', 'gemini'], modelOpenrouter: ['models', 'openrouter'], keyLlm7: ['keys', 'llm7'], modelLlm7: ['models', 'llm7'], keyPollinations: ['keys', 'pollinations'] };
for (const [id, [a, b]] of Object.entries(keyFields)) $('#' + id).value = settings[a][b] || '';
$('#btnSaveKeys').onclick = () => { for (const [id, [a, b]] of Object.entries(keyFields)) settings[a][b] = $('#' + id).value.trim(); saveSettings(); toast('Chaves salvas só neste aparelho ✓'); };

$('#setPersona').value = settings.persona;
$('#btnSavePersona').onclick = () => { settings.persona = $('#setPersona').value.trim() || DEFAULT_PERSONA; saveSettings(); toast('Personalidade salva'); };
$('#btnResetPersona').onclick = () => { settings.persona = DEFAULT_PERSONA; $('#setPersona').value = DEFAULT_PERSONA; saveSettings(); };
$('#setTheme').value = settings.theme;
$('#setTheme').onchange = () => { settings.theme = $('#setTheme').value; saveSettings(); applyTheme(); };
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);

$('#btnExport').onclick = exportChats;
$('#btnWipe').onclick = async () => {
  if (!confirm('Apagar conversas, galeria, chaves e ajustes deste aparelho?')) return;
  wipeChats(); Object.keys(localStorage).filter((k) => k.startsWith('mgia.')).forEach((k) => localStorage.removeItem(k));
  toast('Tudo apagado'); setTimeout(() => location.reload(), 800);
};

// offline
$('#setOfflineModel').value = settings.offlineModel;
$('#setOfflineModel').onchange = () => { settings.offlineModel = $('#setOfflineModel').value; settings.offlineReady = false; saveSettings(); checkOffline(); };
async function checkOffline() {
  const el = $('#gpuStatus');
  if (!hasWebGPU()) { el.innerHTML = '⚠️ Este navegador <b>não tem WebGPU</b>, então o modo offline não roda aqui. O chat continua pela nuvem grátis.'; $('#btnDlModel').disabled = true; return; }
  let info = '';
  try { const ad = await navigator.gpu.requestAdapter(); info = ad ? '✅ WebGPU disponível.' : '⚠️ WebGPU existe, mas nenhuma GPU compatível foi encontrada.'; } catch { info = '⚠️ WebGPU indisponível.'; }
  const cached = await offlineCached();
  if (cached && !settings.offlineReady) { settings.offlineReady = true; saveSettings(); }
  el.textContent = info + (cached ? ' Modelo baixado e pronto (ilimitado).' : ' Modelo ainda não baixado.');
}
$('#btnDlModel').onclick = async () => {
  const prog = $('#modelProgress'), b = $('#btnDlModel'); b.disabled = true;
  try {
    await loadOffline((f, t) => setProgress(prog, f, t.length > 60 ? Math.round(f * 100) + '% — ' + t.slice(0, 48) + '…' : t));
    setProgress(prog, 1, 'Pronto! Modo offline ativo ✓');
    if (settings.backend === 'auto') toast('Modelo pronto. Escolha “Offline” no motor para usar sempre sem internet.');
    checkOffline();
  } catch (e) { setProgress(prog, 0, 'Erro: ' + e.message); toast(e.message); }
  finally { b.disabled = false; }
};
$('#btnDelModel').onclick = async () => { if (!confirm('Apagar o modelo offline deste aparelho?')) return; try { await deleteOffline(); toast('Modelo apagado'); } catch (e) { toast(e.message); } checkOffline(); };

// piper
async function checkPiper() { const s = await piperStored(); $('#piperStored').textContent = s.length ? 'Vozes salvas no aparelho: ' + s.join(', ') : 'Nenhuma voz neural baixada ainda (baixa sozinha no primeiro uso).'; }
$('#btnDlVoice').onclick = async () => {
  const b = $('#btnDlVoice'); b.disabled = true;
  try { await piperSession('pt_BR-faber-medium', (f, t) => (b.textContent = t)); toast('Voz Faber pronta ✓'); } catch (e) { toast('Falhou: ' + e.message); }
  finally { b.disabled = false; b.textContent = 'Baixar voz Faber (pt-BR)'; checkPiper(); }
};
$('#btnDelVoices').onclick = async () => { await piperFlush(); toast('Vozes apagadas'); checkPiper(); };

// ---------- PWA ----------
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
$('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

window.addEventListener('hashchange', () => show(location.hash.slice(1)));
initChat();
initImages();
initVideo();
show((location.hash || '#chat').slice(1).replace(/[^a-z]/g, '') || 'chat');
checkOffline();
checkPiper();
window.__mgia = { ready: true };
