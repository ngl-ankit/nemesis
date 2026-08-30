/* ============ NEMESIS — frontend logic ============ */
"use strict";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const transcriptEl = $("transcript");
const coreBtn = $("coreBtn");
const endBtn = $("endBtn");
const retriggerBtn = $("retriggerBtn");

let persona = "ultron";
let listening = false;
let speaking = false;
let recognition = null;
let micError = null;

const history = [];
const fallacies = [];

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status mono" + (cls ? " " + cls : "");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = "bubble " + role;
  div.textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addFallacyPill(name, explanation) {
  const pill = document.createElement("div");
  pill.className = "fallacy-pill";
  pill.innerHTML =
    '<span class="pill-label">FALLACY</span><span>' + escapeHtml(name) + "</span>" +
    (explanation ? '<span class="pill-ex">— ' + escapeHtml(explanation) + "</span>" : "");
  transcriptEl.appendChild(pill);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addPlaceholder(text) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.textContent = text;
  transcriptEl.appendChild(div);
}

function api(path, body) {
  return fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

$("personaBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("personaMenu").classList.toggle("hidden");
});
document.querySelectorAll(".persona-menu button").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    persona = btn.dataset.persona;
    $("personaLabel").textContent = btn.textContent;
    $("personaMenu").classList.add("hidden");
  });
});
document.addEventListener("click", () => $("personaMenu").classList.add("hidden"));

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus("Voice input needs Chrome or Edge", "error");
    addPlaceholder("Voice input needs Chrome or Edge — type coming soon");
    return;
  }
  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    coreBtn.classList.add("active");
    micError = null;
    setStatus("Listening...", "listening");
  };
  recognition.onresult = (event) => {
    const text = (event.results[0][0].transcript || "").trim();
    if (text) handleUserSpeech(text);
  };
  recognition.onend = () => {
    listening = false;
    coreBtn.classList.remove("active");
    if (!speaking) {
      if (micError) setStatus(micError, "error");
      else setStatus("Tap core to speak");
    }
  };
  recognition.onerror = (event) => {
    listening = false;
    coreBtn.classList.remove("active");
    if (speaking) return;
    const hints = {
      "not-allowed": "Mic blocked — allow microphone access (lock icon in address bar), then tap core",
      "service-not-allowed": "Speech service blocked — check browser site permissions",
      "no-speech": "Didn't catch that — tap core and speak clearly",
      "audio-capture": "No microphone found — connect one, then tap core",
      "network": "Speech service unreachable — check your internet connection",
    };
    micError = hints[event.error] || "Mic error (" + event.error + ") — tap core to retry";
    setStatus(micError, "error");
  };
}

function toggleListening() {
  if (speaking) window.speechSynthesis.cancel();
  if (!recognition) initRecognition();
  if (!recognition) return;
  try {
    if (listening) recognition.stop();
    else recognition.start();
  } catch (err) {
    if (err && err.name !== "InvalidStateError") {
      setStatus("Could not start mic — tap core to retry", "error");
    }
  }
}

coreBtn.addEventListener("click", toggleListening);
retriggerBtn.addEventListener("click", toggleListening);

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 0.85;
  speaking = true;
  setStatus("Nemesis is responding...", "thinking");
  utterance.onend = () => {
    speaking = false;
    setStatus("Tap core to speak");
  };
  utterance.onerror = () => {
    speaking = false;
    setStatus("Tap core to speak");
  };
  window.speechSynthesis.speak(utterance);
}

async function handleUserSpeech(text) {
  if (transcriptEl.querySelector(".placeholder")) transcriptEl.innerHTML = "";
  addBubble("user", text);
  const userIndex = history.length;
  history.push({ role: "user", text: text });
  setStatus("Thinking...", "thinking");

  const trimmed = history
    .slice(Math.max(0, history.length - 1 - 6), history.length - 1)
    .map((m) => [m.role, m.text]);

  const [fallacyRes, debateRes] = await Promise.all([
    api("/api/fallacy", { statement: text }).catch(() => ({ fallacy_name: "None", explanation: "" })),
    api("/api/debate", { opinion: text, persona: persona, history: trimmed }).catch(() => ({ counter_argument: "Connection lost. State your point again." })),
  ]);

  const counter = debateRes.counter_argument || "...";
  addBubble("assistant", counter);
  history.push({ role: "assistant", text: counter });

  const name = fallacyRes.fallacy_name;
  if (name && String(name).toLowerCase() !== "none") {
    fallacies.push({ messageIndex: userIndex, name: name, explanation: fallacyRes.explanation || "" });
    addFallacyPill(name, fallacyRes.explanation);
  }
  speak(counter);
}

endBtn.addEventListener("click", async () => {
  if (!history.length) {
    setStatus("Nothing to score yet");
    return;
  }
  if (speaking) window.speechSynthesis.cancel();
  endBtn.disabled = true;
  setStatus("Scoring debate...", "thinking");

  const transcriptText = history
    .map((m) => (m.role === "user" ? "You: " : "Nemesis: ") + m.text)
    .join("\n");

  const report = await api("/api/scorecard", { transcript: transcriptText }).catch(() => null);

  if (!report) {
    endBtn.disabled = false;
    setStatus("Scoring failed — try again");
    return;
  }

  const scoreYou = report.score_you || 0;
  const scoreNemesis = report.score_nemesis || 0;

  $("scoreYou").textContent = scoreYou;
  $("scoreNemesis").textContent = scoreNemesis;
  $("strengths").innerHTML = (report.strengths || []).map((s) => "<li>" + escapeHtml(s) + "</li>").join("");
  $("weaknesses").innerHTML = (report.weaknesses || []).map((w) => "<li>" + escapeHtml(w) + "</li>").join("");
  $("summary").textContent = report.summary || "";
  $("scoreModal").classList.remove("hidden");
  setTimeout(() => { $("scoreBar").style.width = scoreYou + "%"; }, 60);

  const firstUser = history.find((m) => m.role === "user");
  await api("/api/session/save", {
    topic: firstUser ? firstUser.text.slice(0, 80) : "Untitled debate",
    transcript: history.map((m) => ({ role: m.role, text: m.text })),
    fallacies: fallacies,
    score_you: scoreYou,
    score_nemesis: scoreNemesis,
    scorecard_text: report.summary || "",
  }).catch(() => {});

  endBtn.disabled = false;
  setStatus("Tap core to speak");
});

$("closeModal").addEventListener("click", () => {
  $("scoreModal").classList.add("hidden");
  $("scoreBar").style.width = "0";
});

$("historyBtn").addEventListener("click", async () => {
  const data = await api("/api/session/history").catch(() => ({ sessions: [] }));
  const list = $("historyList");
  list.innerHTML = "";

  if (!data.sessions || !data.sessions.length) {
    list.innerHTML = '<li class="history-empty">No debates yet. Speak, then hit End Debate.</li>';
  } else {
    data.sessions.forEach((s) => {
      const li = document.createElement("li");
      li.className = "history-item";
      const date = new Date(s.created_at).toLocaleString();
      li.innerHTML =
        '<div class="history-main"><span class="history-topic">' + escapeHtml(s.topic || "Untitled debate") + "</span>" +
        '<span class="history-date">' + escapeHtml(date) + "</span></div>" +
        '<div class="history-score">' + (s.score_you ?? 0) + " / " + (s.score_nemesis ?? 0) + "</div>";
      list.appendChild(li);
    });
  }
  $("historyModal").classList.remove("hidden");
});

$("closeHistory").addEventListener("click", () => $("historyModal").classList.add("hidden"));

initRecognition();
addPlaceholder("Tap the core and state your opinion");
