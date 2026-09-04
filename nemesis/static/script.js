/* ============================================================================
   NEMESIS — frontend controller
   Voice (Web Speech API) + text input, SSE streaming with sentence-level TTS,
   HUD telemetry, timer, fallacy heatmap, scorecard, history, stats, badges,
   settings/themes/voices/i18n, PWA + offline shell.
   ========================================================================== */
"use strict";

const $ = (id) => document.getElementById(id);
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------------------------------
   Settings (localStorage first for instant boot, synced to server)
   ------------------------------------------------------------------------- */
const DEFAULTS = {
  persona: "ultron",
  difficulty: "adept",
  aggression: 50,
  language: "en",
  theme: "ultron",
  wakePhrase: "Wake up, Ultron",
  autoListen: false,
  timerEnabled: false,
  timerSeconds: 60,
  ttsEnabled: true,
  voiceProfiles: {}, // persona -> voiceURI
};
const settings = Object.assign({}, DEFAULTS, safeParse(localStorage.getItem("nemesis.settings")));
function saveSettings(sync = true) {
  localStorage.setItem("nemesis.settings", JSON.stringify(settings));
  applyTheme(settings.theme);
  if (sync) api("POST", "/api/settings", settings).catch(() => {});
}
function safeParse(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }

/* ---------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const S = {
  awake: false,
  listening: false,
  speaking: false,
  busy: false,
  history: [],       // {role, text}
  fallacies: [],     // {messageIndex, name, explanation}
  strengths: [],     // per user turn 0..100
  startedAt: null,
  integrity: { you: 50, nem: 50 },
  timer: null,
  timerLeft: 0,
  recognition: null,
  wakeRecognition: null,
  micError: null,
  lastLatency: null,
  voices: [],
  sessionId: Math.random().toString(16).slice(2, 10).toUpperCase(),
  config: null,
};

const statusEl = $("status");
const transcriptEl = $("transcript");
const coreBtn = $("core-btn");

/* ---------------------------------------------------------------------------
   Utilities
   ------------------------------------------------------------------------- */
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status mono" + (cls ? " " + cls : "");
}
function esc(str) { const d = document.createElement("div"); d.textContent = String(str ?? ""); return d.innerHTML; }
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
async function api(method, path, body) {
  const t0 = performance.now();
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  S.lastLatency = Math.round(performance.now() - t0);
  $("tele-latency").textContent = String(S.lastLatency).padStart(3, "0");
  if (r.status === 429) { toast("RATE LIMITED — let the core cool down"); throw new Error("429"); }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
function reactor() { return window.Reactor || { setState() {}, pulse() {}, wake: () => Promise.resolve(), setTheme() {} }; }
function setState(name) { reactor().setState(name); }
function applyTheme(name) {
  document.body.dataset.theme = name;
  reactor().setTheme(name);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = name === "jarvis" ? "#031018" : name === "vision" ? "#100c02" : "#020304";
}

/* ---------------------------------------------------------------------------
   Telemetry corners
   ------------------------------------------------------------------------- */
$("tele-session").textContent = S.sessionId;
setInterval(() => { $("tele-clock").textContent = new Date().toISOString().slice(11, 19); }, 1000);
function updateNet() {
  const off = !navigator.onLine;
  document.body.classList.toggle("offline", off);
  $("offline-banner").hidden = !off;
  $("tele-net").textContent = off ? "OFFLINE" : "ONLINE";
  if (off) { setStatus("LINK LOST — RECONNECT TO DEBATE", "error"); setState("offline"); }
  else if (S.awake) { setStatus("TAP CORE TO SPEAK"); setState("idle"); }
}
window.addEventListener("online", updateNet);
window.addEventListener("offline", updateNet);

/* ---------------------------------------------------------------------------
   Transcript rendering
   ------------------------------------------------------------------------- */
function clearPlaceholder() { const p = transcriptEl.querySelector(".placeholder"); if (p) p.remove(); }
function addBubble(role, text, streaming = false) {
  clearPlaceholder();
  const div = document.createElement("article");
  div.className = "bubble " + role + (streaming ? " streaming" : "");
  div.innerHTML = '<span class="who">' + (role === "user" ? "YOU" : "NEMESIS // " + settings.persona.toUpperCase()) + '</span><span class="txt"></span>';
  div.querySelector(".txt").textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}
function addFallacyPill(name, explanation) {
  const pill = document.createElement("div");
  pill.className = "fallacy-pill";
  pill.setAttribute("role", "note");
  pill.innerHTML = '<span class="pill-label">FALLACY</span><span>' + esc(name) + "</span>" + (explanation ? '<span class="pill-ex">— ' + esc(explanation) + "</span>" : "");
  transcriptEl.appendChild(pill);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}
function addStrengthChip(v, label) {
  const c = document.createElement("div");
  c.className = "strength-chip mono";
  c.innerHTML = "STRENGTH <b>" + v + "</b> · " + esc(label);
  transcriptEl.appendChild(c);
}
function updateCounts() {
  const turns = S.history.filter((m) => m.role === "user").length;
  $("tw-count").textContent = turns + (turns === 1 ? " EXCHANGE" : " EXCHANGES");
  $("tele-turn").textContent = String(turns).padStart(2, "0");
  $("tele-fallacy").textContent = String(S.fallacies.length).padStart(2, "0");
  $("pv-scan-note").textContent = S.fallacies.length + " FLAGGED";
}

/* ---------------------------------------------------------------------------
   HUD panels
   ------------------------------------------------------------------------- */
function setVoiceSync(pct, note) {
  $("pv-voice").textContent = pct + "%";
  $("pv-voice-bar").style.width = pct + "%";
  if (note) $("pv-voice-note").textContent = note;
  $("panel-voice").classList.toggle("hot", pct > 60);
}
function setScan(state) {
  const p = $("panel-scan");
  $("pv-scan").textContent = state;
  p.classList.toggle("scanning", state === "SCANNING");
  p.classList.toggle("hot", state === "FLAGGED");
}
function setIntegrity(you, nem) {
  S.integrity = { you, nem };
  $("pv-int-you").textContent = you;
  $("pv-int-nem").textContent = nem;
  $("pv-int-you-bar").style.flex = you;
  $("pv-int-nem-bar").style.flex = nem;
}
function setStrength(v, label) {
  $("pv-str").textContent = v;
  $("pv-str-arc").style.strokeDashoffset = 157 - (157 * v) / 100;
  $("pv-str-arc").style.stroke = v < 40 ? "#ff3b1f" : v < 70 ? "var(--a2)" : "var(--a3)";
  $("pv-str-note").textContent = (label || "ASSESSED").toUpperCase();
  $("panel-strength").classList.add("hot");
  setTimeout(() => $("panel-strength").classList.remove("hot"), 1500);
}
(function gaugeTicks() {
  const g = $("pv-str-ticks");
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI - (Math.PI * i) / 10;
    const r1 = 42, r2 = i % 5 === 0 ? 36 : 39;
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", 60 + Math.cos(a) * r1); l.setAttribute("y1", 62 - Math.sin(a) * r1);
    l.setAttribute("x2", 60 + Math.cos(a) * r2); l.setAttribute("y2", 62 - Math.sin(a) * r2);
    g.appendChild(l);
  }
})();

function showCallout(name) {
  const c = $("fallacy-callout");
  $("fc-name").textContent = name.toUpperCase();
  c.hidden = false;
  clearTimeout(showCallout._t);
  showCallout._t = setTimeout(() => (c.hidden = true), 4200);
}

/* ---------------------------------------------------------------------------
   Timer (round mode) — countdown ring around the core
   ------------------------------------------------------------------------- */
const RING_LEN = 295.3;
function startTimer() {
  if (!settings.timerEnabled) return;
  stopTimer(false);
  S.timerLeft = settings.timerSeconds;
  $("timer-ring").hidden = false;
  $("timer-readout").hidden = false;
  $("timer-ring").classList.remove("warn");
  tickTimer();
  S.timer = setInterval(tickTimer, 1000);
}
function tickTimer() {
  const frac = S.timerLeft / settings.timerSeconds;
  $("timer-arc").style.strokeDashoffset = RING_LEN * (1 - frac);
  $("timer-readout").textContent = S.timerLeft;
  if (S.timerLeft <= 10) $("timer-ring").classList.add("warn");
  if (S.timerLeft <= 0) {
    stopTimer(true);
    toast("TIME — TURN FORFEITED");
    if (S.listening) stopListening();
    if ($("text-input").value.trim()) $("text-form").requestSubmit();
    return;
  }
  S.timerLeft -= 1;
}
function stopTimer(hide = true) {
  clearInterval(S.timer);
  S.timer = null;
  if (hide) { $("timer-ring").hidden = true; $("timer-readout").hidden = true; }
}

/* ---------------------------------------------------------------------------
   Speech synthesis — per-persona voice profiles, word-boundary core pulses
   ------------------------------------------------------------------------- */
const PERSONA_VOICE = {
  ultron:    { pitch: 0.72, rate: 0.98, prefer: [/Daniel/i, /Google UK English Male/i, /Microsoft (Guy|Ryan|David)/i, /male/i] },
  economist: { pitch: 1.0,  rate: 1.08, prefer: [/Google US English/i, /Microsoft (Aria|Jenny|Zira)/i, /Samantha/i] },
  ethicist:  { pitch: 0.95, rate: 0.92, prefer: [/Moira/i, /Karen/i, /Microsoft (Libby|Sonia)/i, /Google UK English Female/i] },
  skeptic:   { pitch: 1.15, rate: 1.12, prefer: [/Alex/i, /Fred/i, /Microsoft Mark/i, /Google UK English Male/i] },
};
function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  S.voices = window.speechSynthesis.getVoices() || [];
  renderVoiceProfiles();
}
if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}
function pickVoice(persona) {
  const lang = settings.language || "en";
  const chosen = settings.voiceProfiles && settings.voiceProfiles[persona];
  if (chosen) { const v = S.voices.find((x) => x.voiceURI === chosen); if (v) return v; }
  const pool = S.voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(lang.toLowerCase()));
  const prefs = (PERSONA_VOICE[persona] || PERSONA_VOICE.ultron).prefer;
  for (const re of prefs) { const v = pool.find((x) => re.test(x.name)); if (v) return v; }
  return pool[0] || S.voices[0] || null;
}

// Sentence queue: lets TTS start on the first complete sentence while streaming
const tts = {
  queue: [], current: null, pending: "",
  reset() { this.queue = []; this.pending = ""; this.current = null; window.speechSynthesis && window.speechSynthesis.cancel(); },
  feed(delta) {
    this.pending += delta;
    const parts = this.pending.split(/(?<=[.!?…])\s+/);
    this.pending = parts.pop() || "";
    parts.forEach((p) => p.trim() && this.enqueue(p.trim()));
  },
  flush() { if (this.pending.trim()) this.enqueue(this.pending.trim()); this.pending = ""; this.done = true; this.tryNext(); },
  enqueue(text) { this.queue.push(text); this.tryNext(); },
  tryNext() {
    if (this.current || !this.queue.length) { if (!this.current && this.done && !this.queue.length) this.onIdle && this.onIdle(); return; }
    if (!settings.ttsEnabled || !("speechSynthesis" in window)) { this.queue = []; this.done && this.onIdle && this.onIdle(); return; }
    const text = this.queue.shift();
    const u = new SpeechSynthesisUtterance(text);
    const prof = PERSONA_VOICE[settings.persona] || PERSONA_VOICE.ultron;
    const v = pickVoice(settings.persona);
    if (v) u.voice = v;
    u.lang = v ? v.lang : settings.language;
    u.pitch = prof.pitch; u.rate = prof.rate;
    let boundaries = 0;
    u.onboundary = (e) => { boundaries++; if (e.name === "word" || !e.name) reactor().pulse(0.7 + Math.min(0.5, (e.charLength || 4) / 12)); };
    // amplitude proxy for browsers without onboundary (Chrome Android)
    const proxy = setInterval(() => { if (!boundaries) reactor().pulse(0.55 + Math.random() * 0.4); }, 190);
    u.onstart = () => { S.speaking = true; setState("speaking"); setStatus("NEMESIS RESPONDING", "speaking"); };
    u.onend = u.onerror = () => { clearInterval(proxy); this.current = null; this.tryNext(); };
    this.current = u;
    window.speechSynthesis.speak(u);
  },
};
function onSpeechIdle() {
  S.speaking = false;
  if (!S.busy) {
    setState("idle");
    setStatus("TAP CORE TO SPEAK");
    if (settings.autoListen && S.awake) setTimeout(() => !S.listening && !S.speaking && startListening(), 350);
  }
}
tts.onIdle = onSpeechIdle;

/* ---------------------------------------------------------------------------
   Speech recognition
   ------------------------------------------------------------------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_HINTS = {
  "not-allowed": "MIC BLOCKED — ALLOW MICROPHONE ACCESS, OR TYPE BELOW",
  "service-not-allowed": "SPEECH SERVICE BLOCKED — TYPE BELOW",
  "no-speech": "NO SPEECH DETECTED — TAP CORE AND TRY AGAIN",
  "audio-capture": "NO MICROPHONE FOUND — TYPE BELOW",
  "network": "SPEECH SERVICE UNREACHABLE — TYPE BELOW",
};
function langTag() { const l = settings.language || "en"; return { en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", hi: "hi-IN", ja: "ja-JP", zh: "zh-CN" }[l] || l; }
function initRecognition() {
  if (!SR) { setStatus("VOICE NEEDS CHROME/EDGE/SAFARI — TYPE BELOW", "error"); return null; }
  const rec = new SR();
  rec.lang = langTag();
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onstart = () => {
    S.listening = true; S.micError = null;
    coreBtn.setAttribute("aria-pressed", "true");
    $("mic-btn").classList.add("active");
    setState("listening");
    setStatus("LISTENING", "listening");
    setVoiceSync(35, "CAPTURING");
    startTimer();
  };
  rec.onresult = (event) => {
    let interim = "", finalText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    const conf = event.results[event.results.length - 1][0].confidence;
    setVoiceSync(Math.round(40 + (conf || 0.5) * 60), interim ? "DECODING…" : "LOCKED");
    if (interim) { $("text-input").placeholder = interim; reactor().pulse(0.3); }
    if (finalText.trim()) { $("text-input").placeholder = "Type your argument…"; handleUserInput(finalText.trim()); }
  };
  rec.onend = () => {
    S.listening = false;
    coreBtn.setAttribute("aria-pressed", "false");
    $("mic-btn").classList.remove("active");
    $("text-input").placeholder = "Type your argument…";
    if (!S.speaking && !S.busy) {
      if (S.micError) { setStatus(S.micError, "error"); setVoiceSync(0, "MIC ERROR"); }
      else { setStatus("TAP CORE TO SPEAK"); setVoiceSync(0, "MIC STANDBY"); }
      setState("idle");
    }
  };
  rec.onerror = (event) => {
    if (event.error === "aborted") return;
    S.micError = MIC_HINTS[event.error] || ("MIC ERROR (" + event.error + ") — TYPE BELOW");
    if (event.error === "not-allowed" || event.error === "audio-capture") $("text-input").focus();
  };
  return rec;
}
function startListening() {
  if (!navigator.onLine) { toast("OFFLINE — RECONNECT TO DEBATE"); return; }
  if (S.speaking) tts.reset(), onSpeechIdle();
  stopWakeListener();
  if (!S.recognition) S.recognition = initRecognition();
  if (!S.recognition) { $("text-input").focus(); return; }
  S.recognition.lang = langTag();
  try { S.recognition.start(); } catch (e) { if (e.name !== "InvalidStateError") setStatus("COULD NOT START MIC — TAP CORE TO RETRY", "error"); }
}
function stopListening() { try { S.recognition && S.recognition.stop(); } catch (e) { /* noop */ } stopTimer(true); }
function toggleListening() { S.listening ? stopListening() : startListening(); }

/* Wake-phrase listener (continuous, low-key) */
function startWakeListener() {
  if (!SR || !settings.autoListen || S.awake && (S.listening || S.speaking || S.busy)) return;
  if (S.wakeRecognition) return;
  const rec = new SR();
  rec.lang = langTag(); rec.continuous = true; rec.interimResults = true;
  const phrase = normalize(settings.wakePhrase);
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (normalize(e.results[i][0].transcript).includes(phrase)) { stopWakeListener(); wakeSequence(true); return; }
    }
  };
  rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { settings.autoListen = false; saveSettings(); stopWakeListener(); } };
  rec.onend = () => { if (S.wakeRecognition === rec) { S.wakeRecognition = null; setTimeout(startWakeListener, 600); } };
  try { rec.start(); S.wakeRecognition = rec; setStatus('LISTENING FOR "' + settings.wakePhrase.toUpperCase() + '"'); } catch (err) { /* noop */ }
}
function stopWakeListener() { const r = S.wakeRecognition; S.wakeRecognition = null; if (r) { r.onend = null; try { r.stop(); } catch (e) { /* noop */ } } }
function normalize(s) { return String(s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim(); }

/* ---------------------------------------------------------------------------
   Wake sequence
   ------------------------------------------------------------------------- */
async function wakeSequence(thenListen) {
  if (S.wakingNow) return;
  S.wakingNow = true;
  setStatus("INITIALISING", "thinking");
  await reactor().wake();
  S.awake = true;
  S.wakingNow = false;
  if (!S.startedAt) S.startedAt = Date.now();
  setState("idle");
  setStatus("ONLINE — STATE YOUR OPINION", "speaking");
  if (thenListen) startListening();
}

/* ---------------------------------------------------------------------------
   Debate turn: SSE stream + parallel fallacy/strength scans
   ------------------------------------------------------------------------- */
function debateParams() {
  return {
    persona: settings.persona, difficulty: settings.difficulty,
    aggression: Number(settings.aggression), language: settings.language,
  };
}
async function handleUserInput(text) {
  if (S.busy || !text) return;
  if (!navigator.onLine) { toast("OFFLINE — RECONNECT TO DEBATE"); return; }
  if (!S.awake) await wakeSequence(false);
  stopTimer(true);
  if (S.listening) stopListening();
  S.busy = true;
  tts.reset(); tts.done = false;

  addBubble("user", text);
  const userIndex = S.history.length;
  S.history.push({ role: "user", text });
  updateCounts();
  setState("thinking");
  setStatus("PROCESSING", "thinking");
  setScan("SCANNING");

  const hist = S.history.slice(Math.max(0, S.history.length - 1 - 8), S.history.length - 1).map((m) => [m.role, m.text]);

  // side-channel scans (don't block the stream)
  const scans = Promise.all([
    api("POST", "/api/fallacy", { statement: text }).catch(() => ({ fallacy_name: "None", explanation: "" })),
    api("POST", "/api/strength", { statement: text }).catch(() => ({ strength: 50, label: "Signal lost" })),
  ]);

  const bubble = addBubble("assistant", "", true);
  const txt = bubble.querySelector(".txt");
  let full = "";
  try {
    full = await streamDebate({ opinion: text, history: hist, ...debateParams() }, (delta) => {
      full += delta;
      txt.textContent = full;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      tts.feed(delta);
      reactor().pulse(0.25);
    });
  } catch (e) {
    // fall back to the non-streaming endpoint, then to the in-character line
    try {
      const r = await api("POST", "/api/debate", { opinion: text, history: hist, ...debateParams() });
      full = r.counter_argument || "";
    } catch (e2) { full = "Recalibrating... state your point again."; }
    txt.textContent = full;
    tts.feed(full);
  }
  bubble.classList.remove("streaming");
  full = full.trim() || "Recalibrating... state your point again.";
  txt.textContent = full;
  S.history.push({ role: "assistant", text: full });
  updateCounts();
  tts.flush();

  const [fal, str] = await scans;
  const name = fal.fallacy_name;
  if (name && String(name).toLowerCase() !== "none") {
    S.fallacies.push({ messageIndex: userIndex, name, explanation: fal.explanation || "" });
    const userBubble = transcriptEl.querySelectorAll(".bubble.user")[S.history.filter((m) => m.role === "user").length - 1];
    if (userBubble && !REDUCED) { userBubble.classList.add("glitch"); setTimeout(() => userBubble.classList.remove("glitch"), 700); }
    addFallacyPill(name, fal.explanation);
    showCallout(name);
    setScan("FLAGGED");
    updateCounts();
  } else setScan("CLEAR");

  const sv = Math.max(0, Math.min(100, Number(str.strength) || 50));
  S.strengths.push(sv);
  setStrength(sv, str.label);
  addStrengthChip(sv, str.label || "");
  // rolling integrity estimate: mean strength minus fallacy penalty
  const mean = S.strengths.reduce((a, b) => a + b, 0) / S.strengths.length;
  const you = Math.round(Math.max(5, Math.min(95, mean - S.fallacies.length * 6)));
  setIntegrity(you, 100 - you);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  S.busy = false;
  if (!S.speaking && (!tts.queue.length)) onSpeechIdle();
}

async function streamDebate(body, onDelta) {
  const t0 = performance.now();
  const r = await fetch("/api/debate/stream", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body), credentials: "same-origin",
  });
  if (r.status === 429) { toast("RATE LIMITED — let the core cool down"); throw new Error("429"); }
  if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "", first = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = /^event: (\w+)/m.exec(chunk); const data = /^data: (.*)$/m.exec(chunk);
      if (!ev || !data) continue;
      const payload = safeParse(data[1]);
      if (ev[1] === "meta" && payload.model) $("tele-model").textContent = payload.model.split("/").pop().slice(0, 11).toUpperCase();
      if (ev[1] === "delta" && payload.t) {
        if (first) { first = false; S.lastLatency = Math.round(performance.now() - t0); $("tele-latency").textContent = String(S.lastLatency).padStart(3, "0"); }
        onDelta(payload.t);
      }
      if (ev[1] === "done") full = payload.text || full;
    }
  }
  return full;
}

/* ---------------------------------------------------------------------------
   End debate → HUD scorecard readout, heatmap, achievements, persistence
   ------------------------------------------------------------------------- */
function heatmapFrom(fallacies, container) {
  const tally = {};
  fallacies.forEach((f) => { const k = String(f.name || "Unknown").trim().replace(/\b\w/g, (c) => c.toUpperCase()); tally[k] = (tally[k] || 0) + 1; });
  const rows = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  container.innerHTML = rows.length ? "" : '<div class="heat-empty">No fallacies detected — clean round.</div>';
  const max = rows[0] ? rows[0][1] : 1;
  rows.forEach(([name, n]) => {
    const row = document.createElement("div");
    row.className = "heat-row";
    row.innerHTML = '<span class="hn">' + esc(name) + '</span><span class="hb"><i></i></span><span class="hc">' + n + "</span>";
    container.appendChild(row);
    requestAnimationFrame(() => setTimeout(() => { row.querySelector("i").style.width = Math.round((n / max) * 100) + "%"; }, 80));
  });
}
function renderScorecard(report, opts = {}) {
  const you = report.score_you || 0, nem = report.score_nemesis || 0;
  $("sc-you").textContent = "0"; $("sc-nem").textContent = "0";
  $("sc-arc-you").style.strokeDashoffset = 326.7; $("sc-arc-nem").style.strokeDashoffset = 326.7;
  $("sc-meta").textContent = (opts.meta || (settings.persona + " // " + settings.difficulty + " // " + new Date().toLocaleDateString())).toUpperCase();
  $("sc-summary").textContent = report.summary || "";
  $("sc-strengths").innerHTML = (report.strengths || []).map((s) => "<li>" + esc(s) + "</li>").join("") || "<li>—</li>";
  $("sc-weaknesses").innerHTML = (report.weaknesses || []).map((w) => "<li>" + esc(w) + "</li>").join("") || "<li>—</li>";
  heatmapFrom(opts.fallacies || S.fallacies, $("sc-heatmap"));
  $("sc-ach").hidden = true; $("sc-ach-list").innerHTML = "";
  $("scorecard").hidden = false;
  $("sc-close").focus();
  // sweep-in animation
  setTimeout(() => {
    $("sc-arc-you").style.strokeDashoffset = 326.7 - (326.7 * you) / 100;
    $("sc-arc-nem").style.strokeDashoffset = 326.7 - (326.7 * nem) / 100;
    countUp($("sc-you"), you); countUp($("sc-nem"), nem);
  }, 120);
}
function countUp(el, to) {
  if (REDUCED) { el.textContent = to; return; }
  const t0 = performance.now();
  (function step(now) { const p = Math.min(1, (now - t0) / 1200); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); })(t0);
}
function showAchievements(list) {
  if (!list || !list.length) return;
  $("sc-ach").hidden = false;
  $("sc-ach-list").innerHTML = list.map((a) => '<span class="badge"><i>' + esc(a.icon) + "</i>" + esc(a.name) + "</span>").join("");
  toast("ACHIEVEMENT UNLOCKED — " + list.map((a) => a.name).join(", "), 4000);
}

$("end-btn").addEventListener("click", async () => {
  if (!S.history.length) { setStatus("NOTHING TO SCORE YET"); toast("STATE AN OPINION FIRST"); return; }
  if (S.busy) return;
  tts.reset(); S.speaking = false; stopListening(); stopWakeListener();
  $("end-btn").disabled = true;
  setState("thinking"); setStatus("COMPUTING VERDICT", "thinking");
  const transcriptText = S.history.map((m) => (m.role === "user" ? "You: " : "Nemesis: ") + m.text).join("\n");
  let report;
  try { report = await api("POST", "/api/scorecard", { transcript: transcriptText }); }
  catch (e) { $("end-btn").disabled = false; setStatus("SCORING FAILED — TRY AGAIN", "error"); setState("idle"); return; }
  renderScorecard(report);
  setIntegrity(report.score_you, report.score_nemesis);
  const firstUser = S.history.find((m) => m.role === "user");
  try {
    const saved = await api("POST", "/api/session/save", {
      topic: firstUser ? firstUser.text.slice(0, 120) : "Untitled debate",
      transcript: S.history, fallacies: S.fallacies, strengths: S.strengths,
      score_you: report.score_you, score_nemesis: report.score_nemesis, scorecard_text: report.summary || "",
      duration_s: S.startedAt ? Math.round((Date.now() - S.startedAt) / 1000) : 0,
      ...debateParams(),
    });
    showAchievements(saved.new_achievements);
  } catch (e) { toast("VERDICT NOT SAVED — OFFLINE?"); }
  $("end-btn").disabled = false;
  setState("idle"); setStatus("TAP CORE TO SPEAK");
});
$("sc-close").addEventListener("click", () => { $("scorecard").hidden = true; resetDebate(); coreBtn.focus(); });
function resetDebate() {
  S.history = []; S.fallacies = []; S.strengths = []; S.startedAt = null;
  transcriptEl.innerHTML = '<div class="placeholder mono">TAP THE CORE — OR TYPE BELOW — AND STATE YOUR OPINION</div>';
  updateCounts(); setIntegrity(50, 50); setScan("IDLE");
  $("pv-str").textContent = "--"; $("pv-str-arc").style.strokeDashoffset = 157; $("pv-str-note").textContent = "AWAITING FIRST POINT";
}

/* Export: image (canvas) + print/PDF */
$("sc-export-img").addEventListener("click", () => exportImage({
  you: Number($("sc-you").textContent), nem: Number($("sc-nem").textContent),
  summary: $("sc-summary").textContent, meta: $("sc-meta").textContent,
  strengths: [...$("sc-strengths").querySelectorAll("li")].map((l) => l.textContent),
  weaknesses: [...$("sc-weaknesses").querySelectorAll("li")].map((l) => l.textContent),
  heat: [...$("sc-heatmap").querySelectorAll(".heat-row")].map((r) => [r.querySelector(".hn").textContent, r.querySelector(".hc").textContent]),
}));
$("sc-export-pdf").addEventListener("click", () => window.print());
function exportImage(d) {
  const W = 1080, H = 1350, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const theme = getComputedStyle(document.body);
  const a1 = theme.getPropertyValue("--a1").trim(), a2 = theme.getPropertyValue("--a2").trim(), a3 = theme.getPropertyValue("--a3").trim(), c1 = theme.getPropertyValue("--c1").trim();
  x.fillStyle = "#020304"; x.fillRect(0, 0, W, H);
  const rg = x.createRadialGradient(W / 2, 420, 10, W / 2, 420, 700); rg.addColorStop(0, hexA(a1, 0.22)); rg.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = rg; x.fillRect(0, 0, W, H);
  x.strokeStyle = hexA(a1, 0.5); x.lineWidth = 3;
  [[40, 40, 1, 1], [W - 40, 40, -1, 1], [40, H - 40, 1, -1], [W - 40, H - 40, -1, -1]].forEach(([px, py, sx, sy]) => { x.beginPath(); x.moveTo(px, py + 60 * sy); x.lineTo(px, py); x.lineTo(px + 60 * sx, py); x.stroke(); });
  x.textAlign = "center"; x.fillStyle = a3; x.font = "700 64px 'Chakra Petch', sans-serif"; x.letterSpacing = "18px"; x.fillText("NEMESIS", W / 2, 150);
  x.font = "500 22px 'JetBrains Mono', monospace"; x.letterSpacing = "4px"; x.fillStyle = "#8f9aa6"; x.fillText("DEBATE VERDICT // " + d.meta, W / 2, 195);
  const radial = (cx, cy, val, col, label) => {
    x.lineWidth = 16; x.strokeStyle = "rgba(255,255,255,0.07)"; x.beginPath(); x.arc(cx, cy, 150, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = col; x.shadowColor = col; x.shadowBlur = 24; x.beginPath(); x.arc(cx, cy, 150, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (val / 100)); x.stroke(); x.shadowBlur = 0;
    x.fillStyle = "#fff"; x.font = "700 110px 'Chakra Petch', sans-serif"; x.letterSpacing = "0px"; x.fillText(val, cx, cy + 38);
    x.fillStyle = "#8f9aa6"; x.font = "500 20px 'JetBrains Mono', monospace"; x.letterSpacing = "6px"; x.fillText(label, cx, cy + 80);
  };
  radial(W / 2 - 240, 440, d.you, a2, "YOU"); radial(W / 2 + 240, 440, d.nem, c1, "NEMESIS");
  x.fillStyle = "#4b5560"; x.font = "500 24px 'JetBrains Mono', monospace"; x.fillText("VS", W / 2, 450);
  x.fillStyle = "#e9eef3"; x.font = "400 28px Inter, sans-serif"; x.letterSpacing = "0px"; wrapText(x, d.summary, W / 2, 680, 880, 38);
  x.textAlign = "left";
  const col = (title, items, px, colr) => { x.fillStyle = "#4b5560"; x.font = "500 18px 'JetBrains Mono', monospace"; x.letterSpacing = "5px"; x.fillText(title, px, 820); x.letterSpacing = "0px"; x.font = "400 22px Inter, sans-serif"; items.slice(0, 3).forEach((s, i) => { x.fillStyle = colr; x.fillRect(px, 852 + i * 60 - 4, 10, 3); x.fillStyle = "#e9eef3"; wrapText(x, s, px + 22, 860 + i * 60, 400, 26, true); }); };
  col("STRENGTHS", d.strengths, 90, a2); col("WEAKNESSES", d.weaknesses, 590, "#ff4d3d");
  x.fillStyle = "#4b5560"; x.font = "500 18px 'JetBrains Mono', monospace"; x.letterSpacing = "5px"; x.fillText("FALLACY HEATMAP", 90, 1090);
  x.letterSpacing = "0px"; x.font = "400 20px Inter, sans-serif";
  if (!d.heat.length) { x.fillStyle = "#8f9aa6"; x.fillText("No fallacies detected — clean round.", 90, 1130); }
  const mx = Math.max(1, ...d.heat.map((h) => Number(h[1])));
  d.heat.slice(0, 4).forEach(([n, cnt], i) => { const y = 1125 + i * 40; x.fillStyle = "#8f9aa6"; x.fillText(n, 90, y + 8); x.fillStyle = "rgba(255,255,255,0.06)"; x.fillRect(360, y - 6, 560, 14); x.fillStyle = a1; x.fillRect(360, y - 6, 560 * (Number(cnt) / mx), 14); x.fillStyle = a3; x.textAlign = "right"; x.fillText(cnt, 980, y + 8); x.textAlign = "left"; });
  x.fillStyle = "#4b5560"; x.font = "500 16px 'JetBrains Mono', monospace"; x.textAlign = "center"; x.letterSpacing = "4px"; x.fillText(location.host.toUpperCase() + " // " + new Date().toISOString().slice(0, 10), W / 2, H - 60);
  c.toBlob(async (blob) => {
    const file = new File([blob], "nemesis-verdict.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: "Nemesis verdict" }); return; } catch (e) { /* fall through */ } }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/png");
}
function hexA(hex, a) { const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
function wrapText(x, text, px, py, maxW, lh, left) {
  const words = String(text || "").split(" "); let line = "", y = py;
  words.forEach((w) => { const t = line + w + " "; if (x.measureText(t).width > maxW && line) { x.fillText(line.trim(), px, y); line = w + " "; y += lh; } else line = t; });
  x.fillText(line.trim(), px, y);
}

/* ---------------------------------------------------------------------------
   Sheets: topics / history / detail / stats / settings
   ------------------------------------------------------------------------- */
let openSheetId = null, lastFocus = null;
function openSheet(id) {
  closeSheet(false);
  lastFocus = document.activeElement;
  openSheetId = id;
  $("sheet-backdrop").hidden = false;
  const el = $(id); el.hidden = false;
  document.querySelectorAll(".nav-btn").forEach((b) => b.setAttribute("aria-expanded", b.getAttribute("aria-controls") === id ? "true" : "false"));
  const f = el.querySelector("button, [href], input, select, [tabindex]:not([tabindex='-1'])"); if (f) f.focus();
}
function closeSheet(restore = true) {
  if (!openSheetId) return;
  $(openSheetId).hidden = true; $("sheet-backdrop").hidden = true; openSheetId = null;
  document.querySelectorAll(".nav-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  if (restore && lastFocus) lastFocus.focus();
}
$("sheet-backdrop").addEventListener("click", () => closeSheet());
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet()));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!$("scorecard").hidden) { $("sc-close").click(); } else closeSheet(); }
  if (openSheetId && e.key === "Tab") trapFocus(e, $(openSheetId));
  if (!$("scorecard").hidden && e.key === "Tab") trapFocus(e, $("scorecard"));
  // global shortcuts (ignore while typing)
  if (e.target.matches("input, select, textarea")) return;
  if (e.key === " " && !openSheetId && $("scorecard").hidden) { e.preventDefault(); coreBtn.click(); }
  if (e.key.toLowerCase() === "t" && !openSheetId) $("text-input").focus();
});
function trapFocus(e, root) {
  const els = [...root.querySelectorAll("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// Topics
$("nav-topics").addEventListener("click", async () => {
  openSheet("sheet-topics");
  const body = $("topics-body");
  if (body.dataset.loaded) return;
  try {
    const t = await api("GET", "/api/topics");
    body.innerHTML = t.categories.map((c) => '<section class="topic-cat"><h3>' + esc(c.label) + "</h3>" + c.topics.map((tp) => '<button type="button" class="topic-btn">' + esc(tp) + "</button>").join("") + "</section>").join("");
    body.dataset.loaded = "1";
    body.querySelectorAll(".topic-btn").forEach((b) => b.addEventListener("click", () => { closeSheet(); handleUserInput(b.textContent); }));
  } catch (e) { body.innerHTML = '<div class="empty">Could not load topics.</div>'; }
});

// History + detail
$("nav-history").addEventListener("click", async () => {
  openSheet("sheet-history");
  const body = $("history-body"); body.innerHTML = '<div class="empty">LOADING…</div>';
  try {
    const { sessions } = await api("GET", "/api/session/history");
    if (!sessions.length) { body.innerHTML = '<div class="empty">No debates yet. Speak, then hit END DEBATE.</div>'; return; }
    body.innerHTML = "";
    sessions.forEach((s) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "hist-item";
      b.innerHTML = '<span class="hist-topic">' + esc(s.topic || "Untitled debate") + '</span><span class="hist-meta mono">' + esc(new Date(s.created_at).toLocaleString()) + " · " + esc(s.persona) + " · " + s.turns + " turns · " + s.fallacy_count + ' fallacies</span><span class="hist-score' + (s.score_you > s.score_nemesis ? " win" : "") + '"><span class="y">' + s.score_you + '</span> <span class="mono" style="color:var(--ink-faint);font-size:11px">/</span> <span class="n">' + s.score_nemesis + "</span></span>";
      b.addEventListener("click", () => openDetail(s.id));
      body.appendChild(b);
    });
  } catch (e) { body.innerHTML = '<div class="empty">Could not load history.</div>'; }
});
async function openDetail(id) {
  openSheet("sheet-detail");
  const body = $("detail-body"); body.innerHTML = '<div class="empty">LOADING…</div>';
  try {
    const s = await api("GET", "/api/session/" + id);
    $("detail-title").textContent = (s.topic || "SESSION").slice(0, 60).toUpperCase();
    body.innerHTML =
      '<div class="detail-head">' + kv("YOU", s.score_you) + kv("NEMESIS", s.score_nemesis) + kv("TURNS", s.turns) + kv("FALLACIES", s.fallacies.length) + kv("PERSONA", s.persona.toUpperCase()) + kv("MODE", s.difficulty.toUpperCase()) + "</div>" +
      '<p class="sc-summary" style="text-align:left;margin:0 0 10px">' + esc(s.scorecard_text) + "</p>" +
      '<div class="detail-actions"><button type="button" class="btn ghost mono small" id="d-replay">REPLAY AS TEXT</button><button type="button" class="btn ghost mono small" id="d-score">SHOW VERDICT</button><button type="button" class="btn ghost mono small" id="d-delete">DELETE</button></div>' +
      '<div class="section-title mono">FALLACY HEATMAP</div><div class="heatmap" id="d-heat"></div>' +
      '<div class="section-title mono">TRANSCRIPT</div><div class="detail-transcript" id="d-transcript"></div>';
    heatmapFrom(s.fallacies, $("d-heat"));
    const tr = $("d-transcript");
    const fmap = {}; s.fallacies.forEach((f) => { fmap[f.messageIndex] = f; });
    s.transcript.forEach((m, i) => {
      const d = document.createElement("article"); d.className = "bubble " + m.role; d.style.maxWidth = "100%";
      d.innerHTML = '<span class="who">' + (m.role === "user" ? "YOU" : "NEMESIS") + '</span><span class="txt"></span>'; d.querySelector(".txt").textContent = m.text; tr.appendChild(d);
      if (fmap[i]) { const p = document.createElement("div"); p.className = "fallacy-pill"; p.style.alignSelf = "stretch"; p.innerHTML = '<span class="pill-label">FALLACY</span><span>' + esc(fmap[i].name) + '</span><span class="pill-ex">— ' + esc(fmap[i].explanation) + "</span>"; tr.appendChild(p); }
    });
    $("d-replay").addEventListener("click", async () => {
      const items = [...tr.querySelectorAll(".bubble")]; items.forEach((b) => (b.style.opacity = 0.25));
      for (const b of items) { b.style.opacity = 1; b.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" }); await new Promise((r) => setTimeout(r, 650)); }
    });
    $("d-score").addEventListener("click", () => { closeSheet(); renderScorecard({ score_you: s.score_you, score_nemesis: s.score_nemesis, summary: s.scorecard_text, strengths: [], weaknesses: [] }, { fallacies: s.fallacies, meta: s.persona + " // " + s.difficulty + " // " + new Date(s.created_at).toLocaleDateString() }); $("sc-close").onclick = () => { $("scorecard").hidden = true; $("sc-close").onclick = null; }; });
    $("d-delete").addEventListener("click", async () => { if (!confirm("Delete this session?")) return; await api("DELETE", "/api/session/" + id); $("nav-history").click(); });
  } catch (e) { body.innerHTML = '<div class="empty">Session not found.</div>'; }
}
function kv(k, v) { return '<div class="kv"><span class="mono">' + k + "</span><b>" + esc(v) + "</b></div>"; }
$("detail-back").addEventListener("click", () => $("nav-history").click());

// Stats
$("nav-stats").addEventListener("click", async () => {
  openSheet("sheet-stats");
  const body = $("stats-body"); body.innerHTML = '<div class="empty">LOADING…</div>';
  try {
    const [st, ach] = await Promise.all([api("GET", "/api/stats"), api("GET", "/api/achievements")]);
    if (!st.total_debates) { body.innerHTML = '<div class="empty">No data yet. Finish a debate to populate stats.</div>'; return; }
    body.innerHTML =
      '<div class="stat-grid">' + kv("DEBATES", st.total_debates) + kv("WINS", st.wins) + kv("AVG SCORE", st.avg_score) + kv("BEST", st.best_score) + kv("WIN STREAK", st.current_streak) + kv("BEST STREAK", st.best_streak) + kv("DAY STREAK", st.day_streak) + kv("LONGEST", st.longest_debate_turns + " TURNS") + "</div>" +
      '<div class="section-title mono">RECENT SCORES</div><div class="spark">' + st.recent_scores.map((v) => '<i style="height:' + Math.max(4, v) + '%" title="' + v + '"></i>').join("") + "</div>" +
      '<div class="section-title mono">MOST COMMON FALLACY — ' + esc(st.most_common_fallacy || "NONE") + '</div><div class="heatmap" id="st-heat"></div>' +
      '<div class="section-title mono">PERSONAS FACED</div><div class="heatmap" id="st-personas"></div>' +
      '<div class="section-title mono">ACHIEVEMENTS ' + ach.achievements.filter((a) => a.unlocked).length + "/" + ach.achievements.length + '</div><div class="ach-grid">' + ach.achievements.map(achCard).join("") + "</div>";
    heatmapFrom(Object.entries(st.fallacy_totals).flatMap(([n, c]) => Array(c).fill({ name: n })), $("st-heat"));
    heatmapFrom(Object.entries(st.persona_counts).flatMap(([n, c]) => Array(c).fill({ name: n })), $("st-personas"));
  } catch (e) { body.innerHTML = '<div class="empty">Could not load stats.</div>'; }
});
function achCard(a) { return '<div class="ach' + (a.unlocked ? " on" : "") + '"><i>' + esc(a.icon) + "</i><b>" + esc(a.name) + "</b><span>" + esc(a.desc) + "</span></div>"; }

// Settings
function bindSeg(id, key, onChange) {
  const seg = $(id);
  const sync = () => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.v || b.dataset.persona) === settings[key])));
  seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; settings[key] = b.dataset.v || b.dataset.persona; sync(); saveSettings(); onChange && onChange(); });
  seg.addEventListener("keydown", (e) => { if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return; const btns = [...seg.querySelectorAll("button")]; const i = btns.findIndex((b) => b.getAttribute("aria-checked") === "true"); const n = btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length]; n.click(); n.focus(); });
  sync();
}
bindSeg("set-difficulty", "difficulty");
bindSeg("set-theme", "theme");
bindSeg("persona-lock", "persona", () => { renderVoiceProfiles(); toast("PERSONA LOCK — " + settings.persona.toUpperCase()); });
$("set-aggression").value = settings.aggression; $("set-aggr-val").textContent = settings.aggression;
$("set-aggression").addEventListener("input", (e) => { settings.aggression = Number(e.target.value); $("set-aggr-val").textContent = settings.aggression; });
$("set-aggression").addEventListener("change", () => saveSettings());
$("set-timer").checked = settings.timerEnabled; $("set-timer").addEventListener("change", (e) => { settings.timerEnabled = e.target.checked; saveSettings(); });
$("set-timer-secs").value = settings.timerSeconds; $("set-timer-secs").addEventListener("change", (e) => { settings.timerSeconds = Number(e.target.value); saveSettings(); });
$("set-wake").value = settings.wakePhrase; $("set-wake").addEventListener("change", (e) => { settings.wakePhrase = e.target.value.trim() || DEFAULTS.wakePhrase; e.target.value = settings.wakePhrase; saveSettings(); updateIdleStatus(); });
$("set-autolisten").checked = settings.autoListen; $("set-autolisten").addEventListener("change", (e) => { settings.autoListen = e.target.checked; saveSettings(); e.target.checked ? startWakeListener() : stopWakeListener(); updateIdleStatus(); });
$("set-tts").checked = settings.ttsEnabled; $("set-tts").addEventListener("change", (e) => { settings.ttsEnabled = e.target.checked; saveSettings(); });
$("set-language").addEventListener("change", (e) => { settings.language = e.target.value; saveSettings(); if (S.recognition) S.recognition.lang = langTag(); renderVoiceProfiles(); });
$("voice-test").addEventListener("click", () => { tts.reset(); tts.done = false; tts.enqueue({ en: "Your premise collapses under scrutiny.", es: "Tu premisa se derrumba bajo escrutinio.", fr: "Votre prémisse s'effondre sous examen.", de: "Ihre Prämisse bricht unter Prüfung zusammen.", it: "La tua premessa crolla sotto esame.", pt: "Sua premissa desmorona sob escrutínio.", hi: "आपका तर्क जांच में टिक नहीं पाता।", ja: "あなたの前提は精査に耐えられない。", zh: "你的前提经不起推敲。" }[settings.language] || "Your premise collapses under scrutiny."); });
function renderVoiceProfiles() {
  const wrap = $("voice-profiles");
  const personas = ["ultron", "economist", "ethicist", "skeptic"];
  const pool = S.voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith((settings.language || "en").toLowerCase()));
  const list = pool.length ? pool : S.voices;
  wrap.innerHTML = personas.map((p) => { const auto = pickVoice(p); return '<label class="vp-row"><span>' + p.toUpperCase() + '</span><select data-p="' + p + '" aria-label="Voice for ' + p + '"><option value="">AUTO' + (auto ? " (" + esc(auto.name) + ")" : "") + "</option>" + list.map((v) => '<option value="' + esc(v.voiceURI) + '"' + ((settings.voiceProfiles || {})[p] === v.voiceURI ? " selected" : "") + ">" + esc(v.name) + " · " + esc(v.lang) + "</option>").join("") + "</select></label>"; }).join("");
  wrap.querySelectorAll("select").forEach((sel) => sel.addEventListener("change", () => { settings.voiceProfiles = settings.voiceProfiles || {}; if (sel.value) settings.voiceProfiles[sel.dataset.p] = sel.value; else delete settings.voiceProfiles[sel.dataset.p]; saveSettings(); }));
}
$("nav-settings").addEventListener("click", async () => {
  openSheet("sheet-settings");
  renderVoiceProfiles();
  try { const a = await api("GET", "/api/achievements"); $("ach-grid").innerHTML = a.achievements.map(achCard).join(""); } catch (e) { /* offline */ }
});
function updateIdleStatus() { if (!S.awake && !S.listening) setStatus(settings.autoListen ? 'LISTENING FOR "' + settings.wakePhrase.toUpperCase() + '"' : 'SAY "' + settings.wakePhrase.toUpperCase() + '" OR TAP CORE'); }

/* ---------------------------------------------------------------------------
   Core / dock controls
   ------------------------------------------------------------------------- */
coreBtn.addEventListener("click", async () => {
  if (window.__nemesisAudio && window.__nemesisAudio.state === "suspended") window.__nemesisAudio.resume();
  if (!S.awake) { await wakeSequence(true); return; }
  if (S.speaking) { tts.reset(); onSpeechIdle(); return; }
  toggleListening();
});
$("mic-btn").addEventListener("click", () => coreBtn.click());
$("text-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("text-input").value.trim();
  if (!v) return;
  $("text-input").value = "";
  handleUserInput(v);
});
$("text-input").addEventListener("focus", () => { if (settings.timerEnabled && S.awake && !S.timer && !S.busy) startTimer(); });

/* ---------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
(async function boot() {
  applyTheme(settings.theme);
  document.addEventListener("reactor:ready", () => applyTheme(settings.theme));
  updateNet();
  updateIdleStatus();
  // language options
  const sel = $("set-language");
  try {
    const cfg = await api("GET", "/api/config");
    S.config = cfg;
    $("tele-model").textContent = cfg.model.split("/").pop().slice(0, 11).toUpperCase();
    sel.innerHTML = Object.entries(cfg.languages).map(([k, v]) => '<option value="' + k + '"' + (k === settings.language ? " selected" : "") + ">" + esc(v) + "</option>").join("");
    if (!cfg.llm_configured) toast("GROQ_API_KEY NOT SET — RESPONSES WILL BE FALLBACKS", 5000);
    $("set-footer").textContent = "MODEL " + cfg.model + " · BUILD " + cfg.version;
    // merge server settings (server wins for cross-device sync)
    const remote = await api("GET", "/api/settings").catch(() => ({}));
    if (remote && Object.keys(remote).length) { Object.assign(settings, remote); saveSettings(false); location.reload.call && refreshControls(); }
  } catch (e) { sel.innerHTML = '<option value="en">English</option>'; }
  if (settings.autoListen && SR) startWakeListener();
  // PWA
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; if (!localStorage.getItem("nemesis.installHint")) { toast("TIP — OPEN SETTINGS TO INSTALL NEMESIS ON YOUR HOME SCREEN", 4500); localStorage.setItem("nemesis.installHint", "1"); } const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost mono small"; b.textContent = "INSTALL APP"; b.style.marginTop = "8px"; b.addEventListener("click", () => installPrompt && installPrompt.prompt()); $("set-footer").before(b); });
})();
function refreshControls() {
  document.querySelectorAll("#set-difficulty button, #set-theme button, #persona-lock button").forEach((b) => { const key = b.closest("#set-difficulty") ? "difficulty" : b.closest("#set-theme") ? "theme" : "persona"; b.setAttribute("aria-checked", String((b.dataset.v || b.dataset.persona) === settings[key])); });
  $("set-aggression").value = settings.aggression; $("set-aggr-val").textContent = settings.aggression;
  $("set-timer").checked = !!settings.timerEnabled; $("set-timer-secs").value = settings.timerSeconds || 60;
  $("set-wake").value = settings.wakePhrase; $("set-autolisten").checked = !!settings.autoListen; $("set-tts").checked = settings.ttsEnabled !== false;
  $("set-language").value = settings.language || "en";
  applyTheme(settings.theme); updateIdleStatus();
}
