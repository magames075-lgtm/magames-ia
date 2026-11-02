// Armazenamento local simples (tudo fica só no navegador)
const KEY = 'mgia.settings';
export const DEFAULT_PERSONA = `Você é a MaGames IA, assistente da MaGames Tecnologia. Responda sempre em português do Brasil, de forma direta, inteligente e útil, com um toque de humor quando couber. Use markdown (listas, negrito, tabelas e blocos de código com a linguagem indicada) quando ajudar. Para código, entregue soluções completas e funcionais. Se não souber algo ou se a informação puder estar desatualizada, diga com honestidade.`;

const DEFAULTS = {
  persona: DEFAULT_PERSONA,
  theme: 'dark',
  voice: 'pt-BR-FranciscaNeural',
  videoVoice: 'pt-BR-AntonioNeural',
};

function merge(a, b) {
  const o = { ...a };
  for (const k in b) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? { ...(a[k] || {}), ...b[k] } : b[k];
  return o;
}

export const settings = merge(DEFAULTS, safeParse(localStorage.getItem(KEY), {}));
if (String(settings.voice).includes(':')) settings.voice = DEFAULTS.voice; // migração v1 (Piper/sistema)
export function saveSettings() { localStorage.setItem(KEY, JSON.stringify(settings)); }

export function safeParse(s, fb) { try { return s ? JSON.parse(s) : fb; } catch { return fb; } }
export function load(k, fb) { return safeParse(localStorage.getItem('mgia.' + k), fb); }
export function save(k, v) {
  try { localStorage.setItem('mgia.' + k, JSON.stringify(v)); }
  catch (e) { console.warn('localStorage cheio', e); toast('Armazenamento cheio: apague conversas antigas.'); }
}

let tt;
export function toast(msg, ms = 3200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), ms);
}

export function setProgress(el, frac, text) {
  el.hidden = false;
  el.querySelector('div').style.width = Math.max(0, Math.min(100, frac * 100)).toFixed(1) + '%';
  el.querySelector('span').textContent = text ?? Math.round(frac * 100) + '%';
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
