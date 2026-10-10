/* app.js — LearnLoop PWA logic. Works on phone and desktop from the same origin. */

const API = ""; // same origin (FastAPI serves the PWA)
let uid = localStorage.getItem("learnloop_uid") || "learner";
localStorage.setItem("learnloop_uid", uid);

// ── Tab switching ────────────────────────────────────────────────
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "vault") loadVault("known");
  });
});

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 1800);
}

// ── Voice capture (web-mic fallback for any device) ──────────────
const micBtn = document.getElementById("mic-btn");
const micState = document.getElementById("mic-state");
let recognition = null;
let listening = false;
let buffer = "";
let flushTimer = null;

const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechAPI) {
  micBtn.disabled = true;
  micState.textContent = "Mic not supported — type in Ask tab";
} else {
  recognition = new SpeechAPI();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    let interim = "";
    for (const r of e.results[e.resultIndex]) {
      if (r.isFinal) buffer += r[0].transcript + " ";
      else interim += r[0].transcript;
    }
    micState.textContent = interim ? `Hearing: ${interim.slice(0, 40)}` : "Listening…";
    scheduleFlush();
  };
  recognition.onerror = () => stopMic();
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushTranscript, 4000);
}

async function flushTranscript() {
  if (!buffer.trim()) return;
  const text = buffer.trim();
  buffer = "";
  await fetch(`${API}/api/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, uid, source: "web-mic" }),
  });
}

function startMic() {
  listening = true;
  micBtn.classList.add("listening");
  recognition.start();
}
function stopMic() {
  listening = false;
  micBtn.classList.remove("listening");
  micState.textContent = "Tap the mic";
  flushTranscript();
  try { recognition.stop(); } catch {}
}
micBtn.addEventListener("click", () => (listening ? stopMic() : startMic()));

// ── Proactive card feed (the winning hook) ───────────────────────
const cardsEl = document.getElementById("cards");
const emptyEl = document.getElementById("cards-empty");

function renderCard(card) {
  emptyEl.style.display = "none";
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `
    <span class="tag">Proactive · you didn't ask</span>
    <h3>${escapeHtml(card.term)}</h3>
    <p>${escapeHtml(card.explanation)}</p>
    <div class="actions">
      <button class="btn-got">Got it — add to vault</button>
      <button class="btn-dismiss">Not now</button>
    </div>`;
  el.querySelector(".btn-got").addEventListener("click", async () => {
    await fetch(`${API}/api/acknowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, term: card.term, explanation: card.explanation }),
    });
    el.remove();
    toast("Saved to your vault ✓");
  });
  el.querySelector(".btn-dismiss").addEventListener("click", () => el.remove());
  cardsEl.prepend(el);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function pollProactive() {
  try {
    const res = await fetch(`${API}/api/proactive?uid=${uid}`);
    const data = await res.json();
    (data.cards || []).forEach(renderCard);
  } catch {}
}
setInterval(pollProactive, 4000);
pollProactive();

// ── Reactive Ask pipeline (multi-agent, observable) ──────────────
const answerEl = document.getElementById("answer");
const logsEl = document.getElementById("agent-logs");

async function sendAsk() {
  const input = document.getElementById("query");
  const q = input.value.trim();
  if (!q) return;
  answerEl.classList.add("hidden");
  logsEl.innerHTML = "";
  const res = await fetch(`${API}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, uid }),
  });
  const data = await res.json();
  (data.logs || []).forEach((line) => {
    const li = document.createElement("li");
    li.innerHTML = line.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    logsEl.appendChild(li);
  });
  answerEl.textContent = data.final_answer || "No answer.";
  answerEl.classList.remove("hidden");
}
document.getElementById("ask-send").addEventListener("click", sendAsk);
document.getElementById("query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendAsk();
});

// ── Vault + review ───────────────────────────────────────────────
document.querySelectorAll(".subtabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".subtabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadVault(btn.dataset.vault);
  });
});

async function loadVault(mode) {
  const list = document.getElementById("vault-list");
  list.innerHTML = "";
  const url = mode === "review" ? "/api/review" : "/api/vault";
  const res = await fetch(`${API}${url}?uid=${uid}`);
  const data = await res.json();
  const items = mode === "review" ? data.due : data.concepts;
  if (!items.length) {
    list.innerHTML = `<div class="empty">Nothing here yet.</div>`;
    return;
  }
  items.forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>${escapeHtml(c.concept)}</span>
      <span class="lvl">Lv ${c.mastery ?? 1}</span>
      <span class="x" title="forget">✕</span>`;
    chip.querySelector(".x").addEventListener("click", async () => {
      await fetch(`${API}/api/forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, concept: c.concept }),
      });
      chip.remove();
    });
    list.appendChild(chip);
  });
}

// Service worker for offline shell
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
