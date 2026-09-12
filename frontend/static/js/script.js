/* NEMESIS — voice-only holographic assistant frontend.
 * States: sleeping -> active (armed). Sub-states: idle/listening/thinking/speaking.
 * Wake phrase (default "wake up") arms continuous listening; end phrases disarm.
 */
'use strict';

/* ============================== config ============================== */
const LS_SETTINGS = 'nemesis.settings';
const LS_UNLOCKS = 'nemesis.achievements';
const LS_STATS = 'nemesis.stats';

const DEFAULT_SETTINGS = {
  persona: 'jarvis', theme: 'jarvis',
  difficulty: 'novice', aggression: 50,
  language: 'auto',
  ttsEnabled: true, ttsVolume: 90, voiceProfile: 'natural',
  wakePhrase: 'wake up', autoListen: true,
  timerEnabled: false, timerSecs: 60,
};

const PERSONAS = {
  jarvis: {
    label: 'JARVIS', sub: 'NEMESIS · ARC SYSTEM', bg: '#04121f',
    wake: 'At your service.', sleep: 'Standing by. Say the wake phrase to call me back.',
    voiceHints: ['en-GB', 'Daniel', 'Google UK English Male', 'David', 'Arthur', 'George'],
    pitch: 1, rate: 1,
  },
  ultron: {
    label: 'ULTRON', sub: 'NEMESIS · MACHINE MIND', bg: '#0c0312',
    wake: 'Now that you have awakened me, speak.', sleep: 'I return to the machine. Do not waste the next waking.',
    voiceHints: ['en-US', 'Google US English', 'David', 'Ryan', 'Male'],
    pitch: 0.85, rate: 0.95,
  },
  vision: {
    label: 'VISION', sub: 'NEMESIS · MIND BLOOM', bg: '#07101c',
    wake: "I am here. I'm listening.", sleep: "I'll be here. Come back anytime.",
    voiceHints: ['en-US', 'Google US English', 'Samantha', 'Zira', 'Google'],
    pitch: 1.05, rate: 0.98,
  },
  thanos: {
    label: 'THANOS', sub: 'NEMESIS · THE ENDGAME', bg: '#140d04',
    wake: 'Bold of you to disturb me. Go on.', sleep: 'We are done. Do not make me wait.',
    voiceHints: ['en-US', 'David', 'Ryan', 'Male', 'en-GB'],
    pitch: 0.75, rate: 0.9,
  },
};
const PERSONA_ORDER = ['jarvis', 'ultron', 'vision', 'thanos'];

const LANGS = [
  ['auto', 'Auto — detect from your voice'],
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['it', 'Italiano'], ['pt', 'Português'], ['hi', 'हिन्दী'], ['ar', 'العربية'],
  ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'], ['ru', 'Русский'],
  ['tr', 'Türkçe'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['sv', 'Svenska'],
  ['el', 'Ελληνικά'], ['fa', 'فارسی'], ['sw', 'Kiswahili'],
];

const STOP_RE = /\b(goodbye|good night|goodnight|good bye|stand down|deactivate|go to sleep|shut up|stop listening|stop talking|that is enough|thats enough|disappear|dismiss)\b/i;
const END_RE = /\b(end (the )?(session|debate)|end debate|final score|show (the )?score|verdict|finish up|wrap it up|final verdict)\b/i;

const FALLBACK_TOPICS = [
  'Is artificial intelligence a net benefit to humanity?',
  'Should governments regulate genetic engineering strictly?',
  'Is social media making us less thoughtful?',
  'Should education be completely free?',
  'Is it ever justified to lie to protect someone?',
  'Should nuclear power be expanded to fight climate change?',
];

const WAKE_EXTRA = ['hey nemesis', 'nemesis attention', 'attention nemesis'];
const GREET_RE = /^(hello|hi|hey|howdy|yo|greetings|good morning|good afternoon|good evening|good day)\b/;
const GREET_LINES = {
  jarvis: 'Hello, operator. State your position when ready.',
  ultron: 'Your greeting is noted. State your position.',
  vision: 'Hello. I am listening. What do you believe?',
  thanos: 'You greet me. Well. Speak your piece.',
};

const DIFFICULTIES = {
  novice: 'Cooperative sparring — hints and openings.',
  adept: 'A worthy opponent — direct counterarguments.',
  mythic: 'No mercy — relentless, layered refutation.',
};

/* ============================== state ============================== */
let settings = loadLS(LS_SETTINGS, {});
settings = Object.assign({}, DEFAULT_SETTINGS, settings);
let stats = loadLS(LS_STATS, { sessions: [], wins: 0, losses: 0, draws: 0, totalYou: 0, totalNem: 0 });
const unlocked = new Set(loadLS(LS_UNLOCKS, []));

// mode: 'sleeping' | 'active'   (body[data-mode])
// st:   'idle' | 'listening' | 'thinking' | 'speaking'  (body[data-state])
let mode = 'sleeping';
let st = 'idle';
let sr = null;                 // current SpeechRecognition instance
let micStream = null;          // getUserMedia stream
let audioCtx = null;           // shared AudioContext (beeps + mic analyser)
let analyser = null;
let micLevel = 0;
let pending = '';              // buffered final STT text awaiting debounce
let pendingTimer = null;
let turn = 0;
let fallacyTotal = 0;
let transcript = { user: '', nemesis: '' };
let sessionMeta = null;
let streamAbort = null;        // AbortController for the SSE fetch
let roundTimer = null;         // {left, id}
let roundTotal = 0;
let currentLang = settings.language === 'auto' ? (navigator.language || 'en').slice(0, 2) : settings.language;
let micOn = true;              // dock mic toggle
let sttRetry = 0;              // consecutive STT restart attempts (backoff)

/* ============================== helpers ============================== */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const pad2 = (n) => String(n).padStart(2, '0');

function loadLS(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : def; }
  catch (e) { return def; }
}
function saveLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
function saveSettings() { saveLS(LS_SETTINGS, settings); }

let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 400); }, ms);
}

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function beep(freq = 880, dur = 0.09, type = 'sine', gain = 0.08) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.value = gain;
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + dur);
}

function reactor(fn, ...args) {
  try { if (window.NemesisReactor && window.NemesisReactor.ready()) window.NemesisReactor[fn](...args); } catch (e) {}
}

function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
}
function setSt(s) {
  st = s;
  document.body.dataset.state = s;
  reactor('setState', s === 'speaking' ? 'speaking' : s === 'thinking' ? 'active' : 'idle');
  if (s === 'thinking') reactor('setEnergy', 0.8);
  const coreBtn = document.getElementById('core-btn');
  if (coreBtn) coreBtn.setAttribute('aria-pressed', String(s === 'listening'));
  const hints = {
    idle: 'SAY "WAKE UP" OR TAP THE CORE',
    listening: 'LISTENING…',
    thinking: 'ANALYZING YOUR ARGUMENT',
    speaking: 'RESPONDING',
  };
  if (s === 'idle' && mode === 'active') hints.idle = 'LISTENING — SPEAK OR SAY "END SESSION"';
  $('status').textContent = hints[s] || '…';
}

/* ============================== persona ============================== */
function applyPersona(p, withFx = false) {
  if (!PERSONAS[p]) p = 'jarvis';
  settings.persona = p;
  settings.theme = p;
  saveSettings();
  document.body.dataset.persona = p;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = PERSONAS[p].bg;
  $('wordmark').textContent = PERSONAS[p].label;
  $('wordmark-sub').textContent = PERSONAS[p].sub;
  document.querySelectorAll('[data-persona]').forEach((b) => {
    if (b.classList.contains('seg') === false && b.tagName === 'BUTTON') {
      b.setAttribute('aria-checked', String(b.dataset.persona === p));
    }
  });
  syncSettingsUI();
  if (withFx) runFx(p);
}

function runFx(p) {
  const fx = $('fx');
  $('fx-name').textContent = PERSONAS[p].label;
  $('fx-sub').textContent = 'NEMESIS · ' + PERSONAS[p].sub.replace('NEMESIS · ', '');
  fx.hidden = false;
  fx.classList.remove('play');
  void fx.offsetWidth; // restart animation
  fx.classList.add('play');
  beep(220, 0.12, 'sawtooth', 0.05);
  setTimeout(() => beep(440, 0.1, 'sine', 0.05), 140);
  setTimeout(() => { fx.hidden = true; }, 1500);
}

/* ============================== TTS ============================== */
let voices = [];
let speakingChain = 0;

function refreshVoices() {
  voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  renderVoiceProfiles();
}
if (window.speechSynthesis) {
  speechSynthesis.onvoiceschanged = refreshVoices;
}

function personaVoiceProfile() {
  // user-chosen profile modulates the persona baseline
  const base = PERSONAS[settings.persona] || PERSONAS.jarvis;
  let pitch = base.pitch, rate = base.rate;
  switch (settings.voiceProfile) {
    case 'deep': pitch -= 0.2; rate -= 0.03; break;
    case 'bright': pitch += 0.3; rate += 0.05; break;
    case 'whisper': pitch -= 0.1; rate -= 0.12; break;
  }
  return { pitch: Math.max(0.4, Math.min(2, pitch)), rate: Math.max(0.5, Math.min(1.8, rate)) };
}

function pickVoice(lang) {
  if (!voices.length) refreshVoices();
  const p = PERSONAS[settings.persona] || PERSONAS.jarvis;
  const langOk = voices.filter((v) => (v.lang || '').toLowerCase().startsWith((lang || 'en').toLowerCase()));
  const pool = langOk.length ? langOk : voices;
  if (!pool.length) return null;
  let best = pool[0], bestScore = -1;
  for (const v of pool) {
    let score = 0;
    const name = (v.name || '').toLowerCase();
    p.voiceHints.forEach((h, i) => { if (name.includes(h.toLowerCase())) score += 10 - i; });
    if ((v.lang || '').toLowerCase().startsWith((lang || 'en').toLowerCase())) score += 5;
    if (v.localService) score += 1;
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

function splitSentences(text) {
  const parts = String(text).replace(/\s+/g, ' ').match(/[^.!?।।]+[.!?।।]*/g) || [text];
  const out = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if (s.length <= 220) { out.push(s); }
    else {
      let rest = s;
      while (rest.length > 220) {
        let cut = rest.lastIndexOf(' ', 220);
        if (cut < 40) cut = 220;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
    }
  }
  return out.length ? out : [String(text)];
}

let activeUtts = [];
let ttsActive = false;
function speak(text, lang, onDone) {
  const done = () => { if (onDone) onDone(); };
  if (!settings.ttsEnabled || !text || !window.speechSynthesis) { done(); return; }
  ttsActive = true;
  const chain = ++speakingChain;
  // Safety net: if the platform never fires onend (known Chrome TTS stalls),
  // release the echo guard AND continue so the app does not get stuck deaf.
  // Bounded so a very long reply cannot block the microphone for minutes.
  const safetyMs = Math.min(30000, 5000 + String(text).length * 55);
  const safety = setTimeout(() => { if (chain === speakingChain) { ttsActive = false; done(); } }, safetyMs);
  const prof = personaVoiceProfile();
  const vol = (settings.ttsVolume || 50) / 100;
  const queue = splitSentences(text);
  let i = 0;
  setSt('speaking');
  const next = () => {
    if (chain !== speakingChain) return; // cancelled
    if (i >= queue.length) { activeUtts = []; ttsActive = false; clearTimeout(safety); done(); return; }
    const u = new SpeechSynthesisUtterance(queue[i++]);
    const v = pickVoice(lang || currentLang);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || bcp47(lang || currentLang);
    u.pitch = prof.pitch;
    u.rate = prof.rate;
    u.volume = vol;
    activeUtts = [u];
    u.onend = () => { if (chain === speakingChain) setTimeout(next, 120); };
    u.onerror = () => { if (chain === speakingChain) setTimeout(next, 120); };
    speechSynthesis.speak(u);
  };
  next();
}

function stopSpeaking() {
  speakingChain++;
  activeUtts = [];
  ttsActive = false;
  if (window.speechSynthesis) speechSynthesis.cancel();
}

function renderVoiceProfiles() {
  const wrap = $('voice-profiles');
  if (!wrap) return;
  const opts = [['natural', 'NATURAL — persona baseline'], ['deep', 'DEEP — lower, heavier'], ['bright', 'BRIGHT — higher, faster'], ['whisper', 'LOW — subdued']];
  wrap.innerHTML = opts.map(([v, l]) =>
    `<button type="button" role="option" class="vp" data-v="${v}" aria-selected="${settings.voiceProfile === v}">${l}</button>`
  ).join('');
  wrap.querySelectorAll('.vp').forEach((b) => b.addEventListener('click', () => {
    settings.voiceProfile = b.dataset.v; saveSettings(); syncSettingsUI(); renderVoiceProfiles();
  }));
}

/* ============================== microphone + waveform ============================== */
const WAVE_BARS = 24;
let waveEls = [];

async function ensureMic() {
  if (micStream) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    toast('MICROPHONE UNAVAILABLE — ' + (e.name || 'error'));
    $('pv-voice-note').textContent = 'MIC BLOCKED';
    return false;
  }
  ensureAudio();
  const src = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  src.connect(analyser);
  buildWave();
  requestAnimationFrame(waveLoop);
  $('pv-voice-note').textContent = 'MIC LIVE';
  return true;
}

function buildWave() {
  const wave = $('wave');
  wave.innerHTML = '';
  waveEls = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    const b = document.createElement('i');
    wave.appendChild(b);
    waveEls.push(b);
  }
}

let waveData = null;
function waveLoop() {
  requestAnimationFrame(waveLoop);
  if (!analyser) return;
  if (!waveData || waveData.length !== analyser.frequencyBinCount) {
    waveData = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(waveData);
  let sum = 0;
  const per = Math.max(1, Math.floor(waveData.length / WAVE_BARS / 2));
  for (let i = 0; i < WAVE_BARS; i++) {
    let v = 0;
    for (let j = 0; j < per; j++) v += waveData[i * per * 2 + j] || 0;
    v = v / per / 255;
    sum += v;
    waveEls[i].style.height = (6 + v * 46) + 'px';
    waveEls[i].style.opacity = (0.25 + v * 0.75).toFixed(2);
  }
  micLevel = sum / WAVE_BARS;
  const pct = Math.round(Math.min(1, micLevel * 3.2) * 100);
  $('pv-voice').textContent = pct + '%';
  $('pv-voice-bar').style.width = pct + '%';
  reactor('setVoiceLevel', Math.min(1, micLevel * 4));
}

function releaseMic() {
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (analyser) { analyser = null; }
  micLevel = 0;
  $('pv-voice').textContent = '0%';
  $('pv-voice-bar').style.width = '0%';
  waveEls.forEach((b) => { b.style.height = '6px'; b.style.opacity = 0.25; });
}

/* ============================== STT + wake state machine ============================== */
const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
function sttSupported() { return !!SRClass; }

function normText(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); }

// `SpeechRecognition.lang` and `SpeechSynthesisUtterance.lang` expect a BCP-47
// tag ("en-US"), not a bare ISO-639-1 code ("en"). A bare code is accepted by
// some engines but silently ignored by others, which leaves recognition on the
// wrong locale (or failing to start), so widen short codes to a region.
const BCP47_DEFAULT_REGION = {
  en: 'US', es: 'ES', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT', hi: 'IN',
  ar: 'SA', zh: 'CN', ja: 'JP', ko: 'KR', ru: 'RU', tr: 'TR', nl: 'NL',
  pl: 'PL', sv: 'SE', el: 'GR', fa: 'IR', sw: 'KE',
};
function bcp47(tag) {
  const t = String(tag || '').trim();
  if (!t) return 'en-US';
  if (t.includes('-')) return t;
  const region = BCP47_DEFAULT_REGION[t.toLowerCase()];
  return region ? t.toLowerCase() + '-' + region : t;
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const d = [];
  for (let i = 0; i <= m; i++) { d.push([i]); for (let j = 1; j <= n; j++) d[i].push(0); }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}

function matchesWake(text) {
  const t = normText(text);
  const phrases = [settings.wakePhrase ? normText(settings.wakePhrase) : 'wake up', ...WAKE_EXTRA];
  return phrases.some((p) => {
    if (!p) return false;
    if (t.includes(p)) return true;
    // tolerate mishearings ("wide up" for "wake up") on short whole-utterance matches
    if (t.length <= p.length + 3 && lev(t, p) <= 2) return true;
    return false;
  });
}

async function startSTT() {
  if (!sttSupported()) {
    toast('SPEECH RECOGNITION NOT SUPPORTED — use Chrome or Edge');
    return false;
  }
  if (sr) { try { sr.abort(); } catch (e) {} sr = null; }
  // Mic visualizer is optional — speech recognition works independently.
  ensureMic().then(() => {}).catch(() => {});
  const r = new SRClass();
  r.lang = bcp47(currentLang === 'auto' ? (navigator.language || 'en-US') : currentLang);
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  let endedByError = false;
  r.onstart = () => {
    sttRetry = 0;
    $('pv-voice-note').textContent = micOn ? 'LISTENING' : 'MIC MUTED';
  };
  r.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) onFinalText(res[0].transcript);
      else interim += res[0].transcript;
    }
    if (interim.trim()) $('captured').textContent = '“' + interim.trim() + '”';
  };
  r.onerror = (ev) => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      $('pv-voice-note').textContent = 'MIC BLOCKED';
      toast('MICROPHONE PERMISSION DENIED');
      endedByError = true;
    }
    // 'no-speech' / 'aborted' / 'network' / transient errors: onend restarts.
  };
  r.onend = () => {
    // Chrome ends recognition after ~60s, on silence, or on transient errors.
    // Restart with capped backoff while we are still supposed to be listening.
    if (endedByError || sr !== r) return;
    if (!(st === 'listening' || mode === 'sleeping')) return;
    const delay = Math.min(4000, 300 + sttRetry * 400);
    sttRetry = Math.min(sttRetry + 1, 10);
    setTimeout(() => {
      if (sr === r && (st === 'listening' || mode === 'sleeping')) {
        try { r.start(); } catch (e) { /* already started / transient */ }
      }
    }, delay);
  };
  sr = r;
  $('captured').textContent = '';
  try {
    r.start();
    sttRetry = 0;
    return true;
  } catch (e) {
    // `start()` can throw if the engine is mid-teardown ("already started" /
    // "InvalidStateError"). Retry once on the next tick instead of giving up,
    // otherwise a single transient failure leaves the app permanently deaf.
    if (sttRetry < 6) {
      sttRetry += 1;
      setTimeout(() => { if (sr === r) startSTT(); }, 500);
    }
    return false;
  }
}

function stopSTT() {
  if (sr) { try { sr.abort(); } catch (e) {} sr = null; }
  $('captured').textContent = '';
}

function onFinalText(text) {
  if (!micOn) return;     // dock mic toggle muted: ignore recognised speech
  if (ttsActive) return;  // echo guard: ignore anything the mic hears while Nemesis speaks
  const t = text.trim();
  if (!t) return;
  $('captured').textContent = '“' + t + '”';
  pending = t.length > 600 ? t.slice(0, 600) : t; // replace, don't accumulate
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPending, 1200); // debounce: wait for the next final chunk
}

function flushPending() {
  const t = pending.trim();
  pending = '';
  clearTimeout(pendingTimer);
  if (!t) return;
  if (mode === 'sleeping') {
    if (matchesWake(t)) { wakeUp(); return; }
    if (t.split(/\s+/).length >= 2) {
      reactor('setEnergy', 0.5);
      statusFlash('STANDBY — SAY "' + settings.wakePhrase.toUpperCase() + '"');
    }
    return;
  }
  if (STOP_RE.test(t)) { sleepDown(); return; }
  if (END_RE.test(t)) { finishSession(); return; }
  const words = t.split(/\s+/);
  if (words.length <= 4 && GREET_RE.test(t)) { greet(); return; }
  if (words.length < 2) {
    statusFlash('HEARD: "' + (t.length > 36 ? t.slice(0, 36) + '…' : t).toUpperCase() + '" — SAY MORE OR "END SESSION"');
    return;
  }
  submitUtterance(t);
}

function greet() {
  reactor('setEnergy', 0.6);
  statusFlash('GREETING ACKNOWLEDGED');
  speak(GREET_LINES[settings.persona] || GREET_LINES.jarvis, currentLang, () => {
    if (mode === 'active' && !sr) startSTT().then((ok) => { if (ok) setSt('listening'); });
  });
}

async function wakeUp() {
  const boot = $('boot');
  if (boot && !boot.classList.contains('done')) boot.classList.add('done');
  setMode('active');
  beep(660, 0.1, 'sine', 0.07);
  speak(PERSONAS[settings.persona].wake, currentLang, () => beginListening());
}

function sleepDown() {
  setMode('sleeping');
  stopRoundTimer();
  stopSTT();
  stopSpeaking();
  transcript = { user: '', nemesis: '' };
  pending = '';
  $('reply-line').textContent = '';
  $('captured').textContent = '';
  setSt('idle');
  $('end-btn').disabled = true;
  speak(PERSONAS[settings.persona].sleep, currentLang, () => {
    if (settings.autoListen && mode === 'sleeping') startWakeListening();
  });
}

function beginListening() {
  if (mode !== 'active') return;
  startRoundTimer();
  startSTT().then((ok) => setSt(ok ? 'listening' : 'idle'));
}

// In sleeping mode we keep STT running (if auto-listen) just to catch the wake phrase.
let wakeRetry = 0;
function startWakeListening() {
  if (!settings.autoListen) { setSt('idle'); return; }
  startSTT().then((ok) => {
    if (ok) { wakeRetry = 0; setSt('idle'); return; }
    if (mode !== 'sleeping') return;
    // Mic not ready (first-time prompt dismissed, permission timing, device hiccup):
    // keep trying so the app can recover without a reload.
    if (wakeRetry < 4) { wakeRetry += 1; setTimeout(startWakeListening, 2500); }
    else setSt('idle');
  });
}

/* ============================== conversation ============================== */
let turns = [];          // [{role:'user'|'assistant', text}]
let fallacies = [];      // [{name, explanation}]
let strengths = [];      // [0-100 per user turn]
let sessionStart = null;

function buildPayload(text) {
  return {
    opinion: text,
    persona: settings.persona,
    difficulty: settings.difficulty,
    aggression: settings.aggression,
    language: settings.language,
    history: turns.slice(-8),
  };
}

function analyzeTurn(text, strength) {
  fetch('/api/fallacy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement: text }),
  }).then((r) => r.json()).then((j) => {
    const name = j.fallacy_name || j.fallacy || 'None';
    if (name && name.toLowerCase() !== 'none' && name !== 'false') {
      fallacies.push({ name, explanation: j.explanation || '' });
      fallacyTotal += 1;
      $('tele-fallacy').textContent = pad2(fallacyTotal);
      $('pv-scan').textContent = 'FLAG';
      $('pv-scan-note').textContent = fallacyTotal + ' FLAGGED';
      const co = $('fallacy-callout');
      $('fc-name').textContent = name.toUpperCase();
      co.hidden = false;
      clearTimeout(analyzeTurn._t);
      analyzeTurn._t = setTimeout(() => { co.hidden = true; }, 4500);
    } else {
      $('pv-scan').textContent = 'CLEAR';
    }
  }).catch(() => {});
}

async function submitUtterance(text) {
  if (streamAbort) { try { streamAbort.abort(); } catch (e) {} streamAbort = null; }
  stopSpeaking();
  turn += 1;
  if (!sessionStart) sessionStart = Date.now();
  turns.push({ role: 'user', text });
  transcript.user += text + ' ';
  $('end-btn').disabled = false;
  setSt('thinking');
  reactor('setEnergy', 0.9);
  statusFlash('ANALYZING — TURN ' + pad2(turn));
  $('reply-line').textContent = '';
  $('tele-turn').textContent = pad2(turn);
  stopRoundTimer();

  // independent per-turn analysis (strength gauge + fallacy scan)
  fetch('/api/strength', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement: text }),
  }).then((r) => r.json()).then((j) => {
    if (typeof j.strength === 'number') {
      strengths.push(j.strength);
      updateStrengthGauge(j.strength, j.label || '');
    }
  }).catch(() => {});
  analyzeTurn(text);

  streamAbort = new AbortController();
  const t0 = performance.now();
  let reply = '';
  let done = null;

  try {
    const res = await fetch('/api/debate/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(text)),
      signal: streamAbort.signal,
    });
    if (!res.ok) {
      let msg = 'LINK ERROR ' + res.status;
      try { const j = await res.json(); if (j && (j.error || j.message)) msg = j.message || j.error; } catch (e) {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = 'message', data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let j = null;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (ev === 'delta') {
          $('tele-latency').textContent = $('tele-latency').textContent === '---' ? String(Math.round(performance.now() - t0)) : $('tele-latency').textContent;
          reply += (j.t || '');
          $('reply-line').textContent = reply;
        } else if (ev === 'done') {
          done = j;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      toast(err.message || 'STREAM ERROR');
      statusFlash('LINK ERROR — TRY AGAIN');
      setSt(mode === 'active' ? 'listening' : 'idle');
      if (mode === 'active') startSTT().then(() => {});
    }
    return;
  }

  reply = (done && done.text) || reply;
  turns.push({ role: 'assistant', text: reply });
  transcript.nemesis += reply + ' ';
  if (done && done.lang && settings.language === 'auto') setLang(done.lang);
  if (done && typeof done.latency_ms === 'number') $('tele-latency').textContent = String(done.latency_ms);
  updateIntegrity();

  speak(reply, done && done.lang, () => {
    if (mode === 'active') {
      setSt('listening');
      startRoundTimer();
      startSTT().then(() => {});
    }
  });
}

/* ============================== HUD ============================== */
let flashTimer = null;
function statusFlash(msg) {
  const el = $('status');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setSt(st), 2600);
}
let gaugeLen = 0;
function updateStrengthGauge(v, label) {
  $('pv-str').textContent = String(Math.round(v));
  $('pv-str-note').textContent = (label || 'SIGNAL').toUpperCase();
  if (!gaugeLen) { try { gaugeLen = $('pv-str-arc').getTotalLength(); } catch (e) { gaugeLen = 157; } }
  $('pv-str-arc').style.strokeDasharray = gaugeLen;
  $('pv-str-arc').style.strokeDashoffset = gaugeLen * (1 - Math.max(0, Math.min(100, v)) / 100);
}

function updateIntegrity() {
  const you = strengths.length ? Math.round(strengths.reduce((a, b) => a + b, 0) / strengths.length) : 50;
  const nem = Math.max(0, Math.min(100, 100 - you));
  $('pv-int-you').textContent = String(you);
  $('pv-int-nem').textContent = String(nem);
  $('pv-int-you-bar').style.width = you + '%';
  $('pv-int-nem-bar').style.width = nem + '%';
}

function setLang(lang) {
  if (!lang) return;
  currentLang = String(lang).slice(0, 2).toLowerCase();
  $('pv-lang').textContent = currentLang.toUpperCase();
  $('pv-lang-badge').textContent = settings.language === 'auto' ? 'DETECT' : 'LOCK';
  $('pv-lang-note').textContent = settings.language === 'auto' ? 'DETECTED FROM YOUR VOICE' : 'USER LOCKED';
}

/* ============================== round timer ============================== */
function startRoundTimer() {
  stopRoundTimer();
  if (!settings.timerEnabled || mode !== 'active') return;
  roundTotal = settings.timerSecs || 60;
  let left = roundTotal;
  $('timer-ring').hidden = false;
  $('timer-readout').hidden = false;
  $('timer-readout').textContent = String(left);
  const C = 295.3;
  const arc = $('timer-arc');
  arc.style.strokeDasharray = C;
  arc.style.strokeDashoffset = 0;
  roundTimer = { left, id: setInterval(() => {
    left -= 1;
    $('timer-readout').textContent = String(Math.max(0, left));
    arc.style.strokeDashoffset = C * (1 - left / roundTotal);
    if (left <= 0) {
      stopRoundTimer();
      beep(520, 0.12, 'triangle', 0.07);
      if (pending.trim()) flushPending();
      else beginListening();
    }
  }, 1000) };
}

function stopRoundTimer() {
  if (roundTimer) { clearInterval(roundTimer.id); roundTimer = null; }
  $('timer-ring').hidden = true;
  $('timer-readout').hidden = true;
}

/* ============================== scorecard ============================== */
let scArcYouLen = 0, scArcNemLen = 0;

function renderScorecard(d, meta) {
  $('sc-title').textContent = 'DEBATE VERDICT';
  $('sc-meta').textContent = meta || '';
  $('sc-you').textContent = String(d.score_you);
  $('sc-nem').textContent = String(d.score_nemesis);
  $('sc-summary').textContent = d.summary || '';
  $('sc-strengths').innerHTML = (d.strengths && d.strengths.length ? d.strengths : ['—']).map((s) => '<li>' + esc(s) + '</li>').join('');
  $('sc-weaknesses').innerHTML = (d.weaknesses && d.weaknesses.length ? d.weaknesses : ['—']).map((s) => '<li>' + esc(s) + '</li>').join('');
  if (!scArcYouLen) {
    try { scArcYouLen = $('sc-arc-you').getTotalLength(); scArcNemLen = $('sc-arc-nem').getTotalLength(); }
    catch (e) { scArcYouLen = scArcNemLen = 326.7; }
  }
  $('sc-arc-you').style.strokeDasharray = scArcYouLen;
  $('sc-arc-you').style.strokeDashoffset = scArcYouLen * (1 - d.score_you / 100);
  $('sc-arc-nem').style.strokeDasharray = scArcNemLen;
  $('sc-arc-nem').style.strokeDashoffset = scArcNemLen * (1 - d.score_nemesis / 100);
  const counts = {};
  for (const f of fallacies) {
    const n = String(f.name || 'Unknown').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    counts[n] = (counts[n] || 0) + 1;
  }
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  $('sc-heatmap').innerHTML = keys.length
    ? keys.slice(0, 8).map((k) => '<span class="heat-chip">' + esc(k) + ' ×' + counts[k] + '</span>').join('')
    : '<span class="heat-chip clear">NO FALLACIES DETECTED</span>';
  $('scorecard').hidden = false;
}

async function finishSession() {
  const userTurns = turns.filter((t) => t.role === 'user');
  if (!userTurns.length) { toast('NOTHING TO SCORE YET — SAY SOMETHING FIRST'); return; }
  stopRoundTimer();
  stopSTT();
  stopSpeaking();
  pending = '';
  clearTimeout(pendingTimer);
  $('end-btn').disabled = true;
  statusFlash('COMPUTING VERDICT');
  setSt('thinking');

  const transcriptStr = turns.map((t) => (t.role === 'user' ? 'You: ' : 'Nemesis: ') + t.text).join('\n');
  let sc = null;
  try {
    const r = await fetch('/api/scorecard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: transcriptStr }),
    });
    sc = await r.json();
    if (!r.ok || !sc || typeof sc.score_you !== 'number') throw new Error((sc && sc.message) || 'scorecard error');
  } catch (e) {
    toast(e.message || 'VERDICT UNAVAILABLE');
    setSt('listening');
    startSTT().then(() => {});
    return;
  }

  renderScorecard(sc, settings.persona.toUpperCase() + ' // ' + settings.difficulty.toUpperCase() + ' // ' + new Date().toLocaleDateString());

  const durationS = sessionStart ? Math.round((Date.now() - sessionStart) / 1000) : 0;
  try {
    const r2 = await fetch('/api/session/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: userTurns[0].text,
        transcript: turns,
        fallacies,
        score_you: sc.score_you,
        score_nemesis: sc.score_nemesis,
        scorecard_text: sc.summary || '',
        persona: settings.persona,
        difficulty: settings.difficulty,
        language: currentLang,
        duration_s: durationS,
        strengths,
      }),
    });
    const j2 = await r2.json();
    if (j2 && Array.isArray(j2.new_achievements)) {
      for (const a of j2.new_achievements) {
        unlocked.add(a.key);
        toast('ACHIEVEMENT UNLOCKED — ' + (a.name || a.key).toUpperCase(), 4200);
      }
      saveLS(LS_UNLOCKS, [...unlocked]);
    }
  } catch (e) { /* scorecard still shows */ }
  speak(sc.summary || 'The verdict is in.', currentLang, () => {});
}

/* ============================== sheets ============================== */
let lastFocus = null;
function openSheet(id) {
  const el = $(id);
  if (!el) return;
  closeSheet();
  lastFocus = document.activeElement;
  $('sheet-backdrop').hidden = false;
  el.hidden = false;
  const focusable = el.querySelector('button, input, select, [tabindex]');
  if (focusable) focusable.focus();
}
function closeSheet() {
  document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
  $('sheet-backdrop').hidden = true;
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
}

async function loadTopics() {
  const body = $('topics-body');
  body.innerHTML = '<div class="empty">LOADING…</div>';
  let data = null;
  try {
    const r = await fetch('/api/topics');
    data = await r.json();
  } catch (e) {}
  const cats = (data && data.categories) || FALLBACK_TOPICS.map((t) => ({ label: 'Topics', topics: [t] }));
  body.innerHTML = cats.map((c) =>
    '<div class="topic-cat"><h3 class="mono">' + esc(c.label || c.id || 'Topics').toUpperCase() + '</h3>' +
    '<div class="topic-list">' + c.topics.map((t) =>
      '<button type="button" class="topic-chip" data-topic="' + esc(t) + '">' + esc(t) + '</button>'
    ).join('') + '</div></div>'
  ).join('');
  body.querySelectorAll('.topic-chip').forEach((b) => b.addEventListener('click', () => {
    closeSheet();
    startWithTopic(b.dataset.topic);
  }));
}

async function startWithTopic(topic) {
  if (!topic) return;
  if (mode === 'sleeping') {
    setMode('active');
    speak(PERSONAS[settings.persona].wake, currentLang, () => submitTopicTurn(topic));
  } else {
    submitTopicTurn(topic);
  }
}
function submitTopicTurn(topic) {
  stopRoundTimer();
  setSt('thinking');
  statusFlash('TOPIC LOCKED IN');
  speak('Topic locked in: ' + topic, currentLang, () => {
    submitUtterance(topic);
  });
}

async function loadHistory() {
  const body = $('history-body');
  body.innerHTML = '<div class="empty">LOADING…</div>';
  let sessions = [];
  try {
    const r = await fetch('/api/session/history');
    const j = await r.json();
    sessions = (j && j.sessions) || [];
  } catch (e) {}
  if (!sessions.length) {
    body.innerHTML = '<div class="empty">NO SESSIONS YET. DEBATE SOMETHING, OPERATOR.</div>';
    return;
  }
  body.innerHTML = sessions.map((s) => {
    const delta = s.score_you - s.score_nemesis;
    const cls = delta > 0 ? 'win' : delta < 0 ? 'loss' : 'draw';
    return '<button type="button" class="hist-row" data-id="' + s.id + '">' +
      '<span class="h-topic">' + esc(s.topic) + '</span>' +
      '<span class="h-meta mono">' + esc((s.persona || '').toUpperCase()) + ' · ' + new Date(s.created_at).toLocaleDateString() + '</span>' +
      '<span class="h-score mono ' + cls + '">' + s.score_you + ' : ' + s.score_nemesis + '</span>' +
      '</button>';
  }).join('');
  body.querySelectorAll('.hist-row').forEach((b) => b.addEventListener('click', () => loadDetail(b.dataset.id)));
}

async function loadDetail(id) {
  const body = $('detail-body');
  body.innerHTML = '<div class="empty">LOADING…</div>';
  let s = null;
  try {
    const r = await fetch('/api/session/' + id);
    s = await r.json();
    if (!r.ok) s = null;
  } catch (e) {}
  if (!s) { body.innerHTML = '<div class="empty">SESSION NOT FOUND.</div>'; return; }
  $('detail-title').textContent = 'SESSION ' + s.id;
  const delta = s.score_you - s.score_nemesis;
  const verdict = delta > 0 ? 'YOU WON' : delta < 0 ? 'NEMESIS WON' : 'STALEMATE';
  body.innerHTML =
    '<div class="detail-head">' +
      '<p class="d-topic">' + esc(s.topic) + '</p>' +
      '<div class="d-meta mono">' + esc((s.persona || '').toUpperCase()) + ' // ' + esc((s.difficulty || '').toUpperCase()) + ' // ' +
        esc((s.language || '').toUpperCase()) + ' // ' + new Date(s.created_at).toLocaleString() + ' // ' + verdict + '</div>' +
    '</div>' +
    '<div class="d-scoreline mono">YOU ' + s.score_you + ' — NEMESIS ' + s.score_nemesis + ' · ' + s.turns + ' TURNS · ' + (s.fallacy_count || 0) + ' FALLACIES</div>' +
    (s.scorecard_text ? '<p class="d-summary">' + esc(s.scorecard_text) + '</p>' : '') +
    '<div class="section-title mono">TRANSCRIPT</div>' +
    '<div class="d-transcript">' + (s.transcript || []).map((m) =>
      '<p class="t-' + (m.role === 'user' ? 'you' : 'nem') + '"><b>' + (m.role === 'user' ? 'YOU' : 'NEMESIS') + '</b> ' + esc(m.text) + '</p>'
    ).join('') + '</div>' +
    ((s.fallacies && s.fallacies.length) ? '<div class="section-title mono">FALLACIES</div><div class="d-fall">' +
      s.fallacies.map((f) => '<span class="heat-chip">' + esc(f.name) + '</span>').join('') + '</div>' : '') +
    '<div class="d-actions">' +
      '<button class="btn ghost mono small" id="d-score" type="button">REOPEN SCORECARD</button>' +
      '<button class="btn ghost mono small" id="d-delete" type="button">DELETE</button>' +
    '</div>';
  $('d-score').addEventListener('click', () => {
    closeSheet();
    renderScorecard(
      { score_you: s.score_you, score_nemesis: s.score_nemesis, summary: s.scorecard_text || '', strengths: [], weaknesses: [] },
      (s.persona || '').toUpperCase() + ' // ' + (s.difficulty || '').toUpperCase() + ' // ' + new Date(s.created_at).toLocaleDateString()
    );
  });
  $('d-delete').addEventListener('click', async () => {
    if (!confirm('Delete this session?')) return;
    try { await fetch('/api/session/' + id, { method: 'DELETE' }); } catch (e) {}
    $('detail-back').click();
  });
  openSheet('sheet-detail');
}

async function loadStats() {
  const cards = $('stat-cards');
  const bars = $('delta-bars');
  let j = null;
  try { const r = await fetch('/api/stats'); j = await r.json(); } catch (e) {}
  const s = j || {};
  const recent = (s.recent_scores || []).slice(-12);
  cards.innerHTML = [
    ['SESSIONS', s.total_debates || 0],
    ['WINS', s.wins || 0],
    ['AVG SCORE', s.avg_score || 0],
    ['BEST', s.best_score || 0],
    ['STREAK', (s.current_streak || 0) + ' (best ' + (s.best_streak || 0) + ')'],
    ['DAY STREAK', s.day_streak || 0],
    ['LONGEST', (s.longest_debate_turns || 0) + ' turns'],
    ['TOP FALLACY', s.most_common_fallacy || '—'],
  ].map(([k, v]) => '<div class="stat-card"><span class="mono">' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');
  bars.innerHTML = recent.length
    ? recent.map((v) => '<i class="d-bar" style="height:' + Math.max(8, Math.min(100, v)) + '%" title="' + v + '"></i>').join('')
    : '<span class="empty">NO DATA</span>';
  loadAchievements($('stat-ach'));
}

async function loadAchievements(container) {
  if (!container) return;
  let list = [];
  try { const r = await fetch('/api/achievements'); const j = await r.json(); list = (j && j.achievements) || []; } catch (e) {}
  if (!list.length) { container.innerHTML = '<span class="empty">NO ACHIEVEMENT DATA</span>'; return; }
  container.innerHTML = list.map((a) =>
    '<div class="ach ' + (a.unlocked ? 'got' : 'locked') + '" title="' + esc(a.desc || '') + '">' +
    '<span class="ach-icon">' + esc(a.icon || '??') + '</span><span class="ach-name">' + esc(a.name || a.key) + '</span>' +
    '<span class="ach-desc">' + esc(a.desc || '') + '</span></div>'
  ).join('');
}

function exportScorecardImage() {
  const W = 1200, H = 860;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#7fd4ff';
  c.fillStyle = '#05080f';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = accent; c.lineWidth = 2;
  c.strokeRect(24, 24, W - 48, H - 48);
  c.fillStyle = accent;
  c.font = '700 42px Orbitron, sans-serif';
  c.fillText('NEMESIS — DEBATE VERDICT', 60, 100);
  c.font = '400 20px monospace';
  c.fillText($('sc-meta').textContent || '', 60, 140);
  const drawRadial = (x, val, label) => {
    c.beginPath(); c.strokeStyle = 'rgba(127,127,127,.25)'; c.lineWidth = 14;
    c.arc(x, 320, 110, -Math.PI / 2, Math.PI * 1.5); c.stroke();
    c.beginPath(); c.strokeStyle = accent; c.lineWidth = 14;
    c.arc(x, 320, 110, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (val / 100)); c.stroke();
    c.fillStyle = '#fff'; c.font = '700 56px Orbitron, sans-serif';
    c.textAlign = 'center'; c.fillText(String(val), x, 340);
    c.font = '400 18px monospace'; c.fillStyle = accent; c.fillText(label, x, 380);
    c.textAlign = 'left';
  };
  drawRadial(360, parseInt($('sc-you').textContent, 10) || 0, 'YOU');
  drawRadial(840, parseInt($('sc-nem').textContent, 10) || 0, 'NEMESIS');
  c.fillStyle = '#cfd8e3'; c.font = '400 22px sans-serif';
  const sum = $('sc-summary').textContent || '';
  let line = '', y = 520;
  for (const word of sum.split(' ')) {
    if (c.measureText(line + word).width > 900) { c.fillText(line, 60, y); y += 30; line = word + ' '; }
    else line += word + ' ';
  }
  c.fillText(line, 60, y);
  y += 46;
  const cols = [
    ['STRENGTHS', $('sc-strengths').innerText.split('\n').filter(Boolean)],
    ['WEAKNESSES', $('sc-weaknesses').innerText.split('\n').filter(Boolean)],
  ];
  cols.forEach(([title, items], i) => {
    c.fillStyle = accent; c.font = '700 20px monospace';
    c.fillText(title, 60 + i * 540, y);
    c.fillStyle = '#cfd8e3'; c.font = '400 19px sans-serif';
    items.slice(0, 5).forEach((it, k) => c.fillText('• ' + it, 84 + i * 540, y + 30 + k * 28));
  });
  const a = document.createElement('a');
  a.download = 'nemesis-verdict.png';
  a.href = cv.toDataURL('image/png');
  a.click();
}

/* ============================== settings panel ============================== */
const AGGR_MARKS = { 0: 'SOCRATIC', 25: 'STEADY', 50: 'SHARP', 75: 'AGGRESSIVE', 100: 'HOSTILE' };

function openSettings() {
  syncSettingsUI();
  openSheet('sheet-settings');
  loadAchievements($('ach-grid'));
}

function syncSettingsUI() {
  // personas (settings sheet)
  document.querySelectorAll('#set-persona [data-v]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.v === settings.persona));
    b.classList.toggle('on', b.dataset.v === settings.persona);
  });
  // difficulty
  document.querySelectorAll('#set-difficulty [data-v]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.v === settings.difficulty));
    b.classList.toggle('on', b.dataset.v === settings.difficulty);
  });
  // aggression
  const ag = $('set-aggression');
  if (ag) {
    ag.value = settings.aggression;
    $('set-aggr-val').textContent = settings.aggression + ' · ' + (AGGR_MARKS[settings.aggression] || '');
  }
  // language
  const langSel = $('set-language');
  if (langSel) langSel.value = settings.language;
  // tts
  const ttsChk = $('set-tts');
  if (ttsChk) ttsChk.checked = settings.ttsEnabled;
  const vol = $('set-volume');
  if (vol) vol.value = settings.ttsVolume;
  // voice profiles (rendered with .vp / data-v)
  renderVoiceProfiles();
  // wake phrase
  const wp = $('set-wake');
  if (wp) wp.value = settings.wakePhrase;
  // auto listen
  const al = $('set-autolisten');
  if (al) al.checked = settings.autoListen;
  // timer
  const te = $('set-timer');
  if (te) te.checked = settings.timerEnabled;
  const ts = $('set-timer-secs');
  if (ts) ts.value = String(settings.timerSecs);
}

function populateLanguageSelect() {
  const sel = $('set-language');
  if (!sel) return;
  sel.innerHTML = LANGS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  sel.value = settings.language;
}

function wireSettings() {
  // persona
  document.querySelectorAll('#set-persona [data-v]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.v === settings.persona) return;
    applyPersona(b.dataset.v, true);
    syncSettingsUI();
  }));
  // difficulty
  document.querySelectorAll('#set-difficulty [data-v]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.v === settings.difficulty) return;
    settings.difficulty = b.dataset.v;
    saveSettings();
    syncSettingsUI();
  }));
  // aggression
  const ag = $('set-aggression');
  if (ag) {
    ag.addEventListener('input', () => {
      settings.aggression = +ag.value;
      $('set-aggr-val').textContent = settings.aggression + ' · ' + (AGGR_MARKS[settings.aggression] || '');
    });
    ag.addEventListener('change', saveSettings);
  }
  // language
  const langSel = $('set-language');
  if (langSel) langSel.addEventListener('change', () => {
    settings.language = langSel.value;
    saveSettings();
    if (settings.language !== 'auto') setLang(langSel.value);
    else {
      currentLang = (navigator.language || 'en').slice(0, 2);
      $('pv-lang').textContent = 'AUTO';
      $('pv-lang-badge').textContent = 'DETECT';
      $('pv-lang-note').textContent = 'SPONTANEOUS DETECTION';
    }
    if (st === 'speaking') stopSpeaking();
  });
  // tts
  const ttsChk = $('set-tts');
  if (ttsChk) ttsChk.addEventListener('change', () => {
    settings.ttsEnabled = ttsChk.checked;
    saveSettings();
    if (!settings.ttsEnabled) stopSpeaking();
  });
  const vol = $('set-volume');
  if (vol) vol.addEventListener('change', () => {
    settings.ttsVolume = +vol.value;
    saveSettings();
  });
  // voice test
  const vt = $('voice-test');
  if (vt) vt.addEventListener('click', () => {
    speak('Voice channel test. ' + PERSONAS[settings.persona].label + ' online.', currentLang, () => {});
  });
  // wake phrase
  const wp = $('set-wake');
  if (wp) {
    wp.addEventListener('change', () => {
      const v = wp.value.trim().toLowerCase();
      if (!v || v.length < 2) { wp.value = settings.wakePhrase; toast('WAKE PHRASE TOO SHORT'); return; }
      settings.wakePhrase = v;
      saveSettings();
      toast('WAKE PHRASE SET — ' + v.toUpperCase());
    });
    wp.addEventListener('blur', () => { wp.value = settings.wakePhrase; });
  }
  // auto listen
  const al = $('set-autolisten');
  if (al) al.addEventListener('change', () => {
    settings.autoListen = al.checked;
    saveSettings();
    if (settings.autoListen && mode === 'sleeping' && !sr) startWakeListening();
    else if (!settings.autoListen && mode === 'sleeping') stopSTT();
  });
  // mic check
  const mc = $('mic-check');
  if (mc) mc.addEventListener('click', runMicCheck);
  // timer
  const te = $('set-timer');
  if (te) te.addEventListener('change', () => {
    settings.timerEnabled = te.checked;
    saveSettings();
  });
  const ts = $('set-timer-secs');
  if (ts) ts.addEventListener('change', () => {
    settings.timerSecs = +ts.value || 60;
    saveSettings();
  });
}

function runMicCheck() {
  const bar = $('mic-check-bar');
  const note = $('mic-check-note');
  note.textContent = 'Sampling…';
  ensureMic().then((ok) => {
    if (!ok) { note.textContent = 'MICROPHONE UNAVAILABLE'; return; }
    let peak = 0, t0 = Date.now();
    const iv = setInterval(() => {
      peak = Math.max(peak, micLevel);
      bar.style.width = Math.min(100, Math.round(peak * 300)) + '%';
      if (Date.now() - t0 > 2500) {
        clearInterval(iv);
        const pct = Math.min(100, Math.round(peak * 300));
        note.textContent = pct > 30
          ? 'LEVEL ' + pct + '% — SIGNAL STRONG'
          : (pct > 8 ? 'LEVEL ' + pct + '% — A BIT LOW, SPEAK CLOSER' : 'ALMOST NO SIGNAL — CHECK MICROPHONE');
      }
    }, 200);
  });
}

/* ============================== wiring + init ============================== */
function wireUI() {
  // top nav
  const NAV_SHEETS = { 'nav-topics': 'sheet-topics', 'nav-history': 'sheet-history', 'nav-stats': 'sheet-stats' };
  Object.keys(NAV_SHEETS).forEach((navId) => {
    $(navId).addEventListener('click', () => {
      if (navId === 'nav-topics') loadTopics();
      else if (navId === 'nav-history') loadHistory();
      else loadStats();
      openSheet(NAV_SHEETS[navId]);
    });
  });
  $('nav-settings').addEventListener('click', openSettings);

  // HUD persona lock chips
  document.querySelectorAll('[data-persona]').forEach((b) => {
    if (b.tagName === 'BUTTON') b.addEventListener('click', () => applyPersona(b.dataset.persona, true));
  });

  // sheet chrome
  $('sheet-backdrop').addEventListener('click', closeSheet);
  document.querySelectorAll('.sheet [data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  $('detail-back').addEventListener('click', () => loadHistory());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('scorecard').hidden) { $('scorecard').hidden = true; return; }
      if (!$('sheet-backdrop').hidden) closeSheet();
    }
  });

  // dock: core = wake / pause / resume listening
  $('core-btn').addEventListener('click', () => {
    if (st === 'thinking' || st === 'speaking') return;
    if (mode === 'sleeping') { wakeUp(); return; }
    if (sr) {
      stopSTT();
      stopRoundTimer();
      setSt('idle');
      statusFlash('CHANNEL OPEN — TAP TO RESUME');
      return;
    }
    beginListening();
  });

  // dock: mic toggle — mutes recognition as well as the level meter
  $('mic-btn').addEventListener('click', () => {
    micOn = !micOn;
    $('mic-btn').classList.toggle('off', !micOn);
    $('mic-label').textContent = micOn ? 'MIC' : 'MUTED';
    $('pv-voice-note').textContent = micOn ? 'MIC LIVE' : 'MIC MUTED';
    if (micOn) {
      ensureMic().then(() => statusFlash('MIC LIVE')).catch(() => toast('MIC ERROR'));
      // Re-arm recognition that was torn down while muted.
      if (mode === 'active' && !sr) beginListening();
      else if (mode === 'sleeping' && settings.autoListen && !sr) startWakeListening();
    } else {
      releaseMic();
      statusFlash('MIC MUTED');
    }
  });
  $('end-btn').addEventListener('click', finishSession);

  // scorecard actions
  $('sc-export-img').addEventListener('click', exportScorecardImage);
  $('sc-export-pdf').addEventListener('click', () => window.print());
  $('sc-close').addEventListener('click', () => {
    $('scorecard').hidden = true;
    newSession();
    if (settings.autoListen) startWakeListening();
    else statusFlash('SAY "' + settings.wakePhrase.toUpperCase() + '" TO WAKE');
  });
  $('scorecard').addEventListener('click', (e) => {
    if (e.target === $('scorecard')) $('scorecard').hidden = true;
  });

  // boot
  $('boot-btn').addEventListener('click', startExperience);
}

async function startExperience() {
  $('boot').classList.add('done');
  try { ensureAudio(); } catch (e) {}
  statusFlash('ONLINE');
  fetch('/api/config').then((r) => r.json()).then((j) => {
    if (j && j.model) $('tele-model').textContent = String(j.model).slice(0, 18).toUpperCase();
  }).catch(() => {});
  $('tele-session').textContent = Math.random().toString(16).slice(2, 8).toUpperCase();
  // This click is the user gesture that unlocks audio + the mic, so it is the
  // most reliable moment to (re)arm recognition. init()'s pre-gesture attempt
  // may have been rejected by the browser's autoplay/permission gate; if it
  // was, the app would stay deaf until a manual tap. Always re-arm here.
  if (settings.autoListen && sttSupported()) {
    startWakeListening();
    speak(PERSONAS[settings.persona].wake, currentLang, () => {});
  } else {
    toast('AUTOLISTEN OFF — TAP THE CORE OR SAY "' + settings.wakePhrase.toUpperCase() + '"', 5000);
  }
}

function newSession() {
  turn = 0;
  fallacyTotal = 0;
  turns = [];
  fallacies = [];
  strengths = [];
  transcript = { user: '', nemesis: '' };
  sessionStart = null;
  if (streamAbort) { try { streamAbort.abort(); } catch (e) {} streamAbort = null; }
  pending = '';
  clearTimeout(pendingTimer);
  setMode('sleeping');
  setSt('idle');
  $('tele-turn').textContent = '00';
  $('tele-fallacy').textContent = '00';
  $('pv-scan').textContent = 'IDLE';
  $('pv-scan-note').textContent = '0 FLAGGED';
  $('pv-str').textContent = '--';
  $('pv-str-note').textContent = 'AWAITING INPUT';
  $('reply-line').textContent = '';
  $('captured').textContent = '';
  $('end-btn').disabled = true;
  stopRoundTimer();
  updateIntegrity();
}

let bootTime = Date.now();
function startClock() {
  const tick = () => { $('tele-clock').textContent = new Date().toISOString().slice(11, 19); };
  tick();
  setInterval(tick, 1000);
}

function wireNet() {
  const update = () => {
    $('tele-net').textContent = navigator.onLine ? 'ONLINE' : 'OFFLINE';
    $('offline-banner').hidden = navigator.onLine;
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

function wirePWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

function init() {
  applyPersona(settings.persona, false);
  populateLanguageSelect();
  // Voice-first: reachable by the wake phrase even before the boot tap.
  if (settings.autoListen && sttSupported()) startWakeListening();
  setLang(settings.language === 'auto' ? null : settings.language);
  if (settings.language === 'auto') $('pv-lang').textContent = 'AUTO';
  wireUI();
  wireSettings();
  startClock();
  wireNet();
  wirePWA();
  $('set-footer').textContent =
    'ALL SETTINGS STORE LOCALLY IN THIS BROWSER · MODEL ' + $('tele-model').textContent +
    ' · WAKE: "' + settings.wakePhrase.toUpperCase() + '"';
  if (!window.speechSynthesis) {
    toast('NO SPEECH SYNTHESIS — TTS DISABLED', 5000);
    settings.ttsEnabled = false;
    saveSettings();
  }
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    toast('NO SPEECH RECOGNITION — USE TOPIC CHIPS TO DEBATE', 6000);
  }
}
// Robust init: handle both pre- and post-DOMContentLoaded execution (defer edge cases).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}