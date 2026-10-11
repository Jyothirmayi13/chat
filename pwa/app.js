/* app.js — LearnLoop PWA logic. Works on phone and desktop from the same origin. */

const API = ""; // same origin (FastAPI serves the PWA)
let uid = localStorage.getItem("learnloop_uid") || "learner";
const asParam = new URLSearchParams(location.search).get("as");
if (asParam) uid = asParam.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || uid;
localStorage.setItem("learnloop_uid", uid);
document.getElementById("who").textContent = `learner: ${uid}`;

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

// ── Coach switch: the only thing that lets audio be analysed ────
const coachBtn = document.getElementById("coach-toggle");
const coachStatus = document.getElementById("coach-status");
let coachOn = false;

async function setCoach(on) {
  await fetch(`${API}/api/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, on }),
  });
  showCoach(on);
  if (!on) stopMic();
}

function showCoach(on) {
  coachOn = on;
  coachBtn.textContent = on ? "Coach: on" : "Coach: off";
  coachBtn.classList.toggle("off", !on);
  coachBtn.setAttribute("aria-pressed", String(on));
  document.querySelector(".statusbar").classList.toggle("off", !on);
  coachStatus.textContent = on
    ? "Listening — unknown terms get explained before you ask."
    : "Nothing is analysed until you turn the coach on.";
}
coachBtn.addEventListener("click", () => setCoach(!coachOn));
fetch(`${API}/api/coach?uid=${encodeURIComponent(uid)}`)
  .then((r) => r.json()).then((d) => showCoach(!!d.coach)).catch(() => {});

// Leaving the tab should never leave a microphone running behind it.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && listening) stopMic();
});

// ── Voice capture (web-mic fallback for any device) ──────────────
const micBtn = document.getElementById("mic-btn");
const micState = document.getElementById("mic-state");
let recognition = null;
let listening = false;
let buffer = "";
let flushTimer = null;

const heardBox = document.getElementById("heard");
const heardText = document.getElementById("heard-text");

function showHeard(text, note = "") {
  heardBox.classList.remove("hidden");
  heardText.textContent = text + (note ? ` ${note}` : "");
}

const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechAPI) {
  micBtn.disabled = true;
  micState.textContent = "Mic not supported — type in Ask tab";
} else {
  recognition = new SpeechAPI();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    console.log("[mic] recognition started");
    micState.textContent = "Listening… speak now";
  };
  recognition.onresult = (e) => {
    let interim = "";
    // e.results[i] is a result; its [0] is the top transcript alternative.
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) buffer += res[0].transcript + " ";
      else interim += res[0].transcript;
    }
    console.log("[mic] result. interim:", interim, "| buffer:", buffer);
    const heard = (buffer + " " + interim).trim();
    if (heard) showHeard(heard);
    micState.textContent = interim ? "Hearing you…" : "Listening… speak now";
    scheduleFlush();
  };
  // Chrome kills recognition after ~5s of silence; restart while user wants live mode.
  recognition.onend = () => {
    console.log("[mic] recognition ended, listening =", listening);
    if (listening) {
      setTimeout(() => {
        if (!listening) return;
        try { recognition.start(); } catch (err) { console.log("[mic] restart failed", err); }
      }, 350);
    }
  };
  recognition.onerror = (e) => {
    console.log("[mic] error:", e.error);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      micState.textContent = "Mic blocked — click the 🔇/mic icon in the address bar and Allow";
      listening = false;
      micBtn.classList.remove("listening");
    } else if (e.error !== "aborted" && e.error !== "no-speech") {
      micState.textContent = `Mic error: ${e.error} — tap the mic to retry`;
      listening = false;
      micBtn.classList.remove("listening");
    }
    flushTranscript();
  };
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushTranscript, 4000);
}

async function flushTranscript() {
  if (!buffer.trim()) return;
  const text = buffer.trim();
  buffer = "";
  showHeard(text, "→ sending to coach…");
  try {
    await fetch(`${API}/api/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, uid, source: "web-mic" }),
    });
    showHeard(text, "✓ sent — cards incoming");
  } catch {
    showHeard(text, "✗ could not reach server");
  }
}

function startMic() {
  if (!coachOn) setCoach(true);   // tapping the mic is itself the opt-in
  listening = true;
  micBtn.classList.add("listening");
  try { recognition.start(); } catch (err) { console.log("[mic] start threw:", err); }
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
  const heard = (card.grounded_in || []).filter(Boolean).slice(0, 1)
    .map(q => `<p class="why">Heard in this lecture: “${escapeHtml(q)}”</p>`)
    .join("");
  el.innerHTML = `
    <span class="tag">Proactive · you didn't ask</span>
    <h3>${escapeHtml(card.term)}</h3>
    <p>${escapeHtml(card.explanation)}</p>
    ${heard}
    ${traceHtml(card.trace)}
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

function traceHtml(steps) {
  if (!steps || !steps.length) return "";
  const items = steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  return `<details class="trace"><summary>How this card was made (${steps.length} steps)</summary><ol>${items}</ol></details>`;
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
  document.getElementById("known-box").classList.toggle("hidden", mode === "review");
  list.innerHTML = "";
  const url = mode === "review" ? "/api/review" : "/api/vault";
  const res = await fetch(`${API}${url}?uid=${encodeURIComponent(uid)}`);
  const data = await res.json();
  const items = mode === "review" ? data.due : data.concepts;
  if (!items.length) {
    list.innerHTML = mode === "review"
      ? `<div class="empty">Nothing due. New concepts come back after 1 day, then 3, 7, 14, 30.</div>`
      : `<div class="empty">Nothing here yet.</div>`;
    return;
  }
  if (mode === "review") {
    items.forEach((c) => list.appendChild(reviewItem(c)));
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

const NEXT_DAYS = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 30 };

function reviewItem(c) {
  const el = document.createElement("div");
  el.className = "review";
  el.innerHTML = `
    <h3>${escapeHtml(c.concept)}</h3>
    <p>${escapeHtml(c.explanation || "Can you explain this in one sentence?")}</p>
    <div class="actions">
      <button class="btn-got">Remembered</button>
      <button class="btn-dismiss">Forgot</button>
    </div>`;
  const grade = async (remembered) => {
    const res = await fetch(`${API}/api/review/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, concept: c.concept, remembered }),
    });
    const data = await res.json();
    el.remove();
    toast(`Next review in ${NEXT_DAYS[data.mastery] ?? 1} day(s)`);
  };
  el.querySelector(".btn-got").addEventListener("click", () => grade(true));
  el.querySelector(".btn-dismiss").addEventListener("click", () => grade(false));
  return el;
}

async function addKnown() {
  const input = document.getElementById("known-input");
  const concepts = input.value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!concepts.length) return;
  await fetch(`${API}/api/known`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, concepts }),
  });
  input.value = "";
  toast(`Won't explain ${concepts.length} concept(s) to you ✓`);
  loadVault("known");
}
document.getElementById("known-add").addEventListener("click", addKnown);
document.getElementById("known-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addKnown();
});

// Service worker for offline shell
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
