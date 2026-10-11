/**
 * content.js — the floating coach on YouTube watch pages.
 *
 * Three jobs:
 *  1. Read the video's own caption cues while it plays, so the words arrive
 *     correctly spelled and in step with playback — no microphone involved.
 *  2. Expose video id + playback time to popup.js (grounding context).
 *  3. Show a corner bubble that quietly collects proactive cards, so clearing
 *     a doubt never means leaving the video or losing your place.
 */

const HOST = "learnloop-coach";
let backend = "https://learnloop-xh10.onrender.com";
let shadow = null;
let panel = null;
let badge = null;
let statusEl = null;
let coachOn = false;
const queue = [];

chrome.storage.sync.get({ backend_url: backend }, (v) => {
  backend = v.backend_url;
});

// ── Video context helpers ────────────────────────────────────────
function getVideoId() {
  return new URLSearchParams(window.location.search).get("v");
}

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getCurrentTimestamp() {
  const video = document.querySelector("video");
  if (!video || video.readyState === 0) return null;
  return formatTimestamp(video.currentTime);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_YOUTUBE_DATA") {
    const videoId = getVideoId();
    sendResponse({ video_id: videoId, timestamp: getCurrentTimestamp(), success: !!videoId });
  }
  return true;
});

// ── Floating UI (shadow DOM so YouTube's CSS can't touch it) ─────
function mount() {
  if (document.getElementById(HOST)) return;
  const host = document.createElement("div");
  host.id = HOST;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:18px;bottom:110px;";
  document.body.appendChild(host);

  shadow = host.attachShadow({ mode: "open" });
  // YouTube binds its player shortcuts on the document, so keys typed here
  // would pause or seek the video. Stopping at the shadow boundary lets our
  // own handlers run first and keeps the page from ever seeing them.
  for (const type of ["keydown", "keyup", "keypress"]) {
    shadow.addEventListener(type, (e) => e.stopPropagation());
  }
  shadow.innerHTML = `
    <style>
      .btn{position:relative;width:46px;height:46px;border-radius:50%;border:0;cursor:pointer;
        background:#123a2a;color:#5eead4;font-size:20px;box-shadow:0 4px 18px #0009;
        display:grid;place-items:center}
      .btn.off{background:#1c2333;color:#9aa7bd}
      .n{position:absolute;top:-4px;right:-4px;min-width:19px;height:19px;border-radius:999px;
        background:#f59e0b;color:#1a1204;font-size:11px;font-weight:700;display:none;place-items:center;padding:0 4px}
      .p{position:absolute;bottom:56px;right:0;width:320px;height:70vh;
        background:#0b1020;color:#e6edf3;border:1px solid #ffffff1f;border-radius:14px;
        padding:12px;display:none;flex-direction:column;font-family:system-ui,sans-serif}
      .p.open{display:flex}
      .hd{display:flex;justify-content:space-between;align-items:baseline}
      .h{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#f59e0b;margin:0 0 4px}
      .x{font-size:11px;color:#7dd3fc;cursor:pointer;text-decoration:underline}
      .s{font-size:11px;color:#5eead4;margin:0 0 8px;min-height:14px}
      .l{overflow:auto;flex:1;min-height:40px}
      .c{border-top:1px solid #ffffff14;padding:10px 0}
      .c b{display:block;color:#7dd3fc;font-size:14px;margin-bottom:4px}
      .c p{margin:0 0 6px;font-size:13px;line-height:1.45}
      .c i{display:block;font-size:11px;color:#8b98ad;margin-bottom:8px}
      .c details{margin:0 0 8px}
      .c summary{font-size:11px;color:#8b98ad;cursor:pointer}
      .c ol{margin:6px 0 0;padding-left:18px;font-size:11px;color:#8b98ad;line-height:1.5}
      .a{display:flex;gap:6px}
      .a button{flex:1;padding:6px;border-radius:8px;border:0;font-size:12px;font-weight:600;cursor:pointer}
      .g{background:#34d399;color:#06251a}
      .d{background:#ffffff12;color:#9aa7bd}
      .e{font-size:12px;color:#8b98ad;text-align:center;padding:14px 0}
      .q{display:flex;gap:6px;margin-top:8px}
      .q input{flex:1;min-width:0;background:#121a2e;border:1px solid #ffffff26;border-radius:8px;
        color:#e6edf3;padding:7px 9px;font-size:12px;font-family:inherit}
      .q button{padding:6px 12px;border-radius:8px;border:0;font-size:12px;font-weight:700;
        cursor:pointer;background:#7dd3fc;color:#06222e}
      .ans{font-size:12px;line-height:1.5;margin-top:8px;max-height:22vh;overflow:auto}
      .ans details{margin:0 0 6px}
      .ans summary{font-size:11px;color:#8b98ad;cursor:pointer}
      .ans ol{margin:4px 0 0;padding-left:16px;font-size:11px;color:#8b98ad;line-height:1.5}
      .ans .at{margin:0;color:#e6edf3}
    </style>
    <button class="btn off" title="LearnLoop coach">🧠<span class="n"></span></button>
    <div class="p">
      <div class="hd"><p class="h">Proactive · you didn't ask</p><span class="x" title="Open the full LearnLoop app">full app ↗</span></div>
      <p class="s"></p>
      <div class="l"><div class="e">No cards yet.</div></div>
      <div class="q"><input type="text" placeholder="Ask about anything in this video" /><button>Ask</button></div>
      <div class="ans"></div>
    </div>`;

  panel = shadow.querySelector(".p");
  badge = shadow.querySelector(".n");
  statusEl = shadow.querySelector(".s");
  const btn = shadow.querySelector(".btn");
  btn.addEventListener("click", async () => {
    panel.classList.toggle("open");
    const want = panel.classList.contains("open");
    if (want === coachOn) return;
    // Opening the bubble is the learner's opt-in: nothing is read until then.
    try {
      await fetch(`${backend}/api/coach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: "learner", on: want }),
      });
    } catch {
      panel.classList.remove("open");
      setStatus("Backend unreachable — coach stayed off");
      return;
    }
    coachOn = want;
    btn.classList.toggle("off", !want);
    if (want) {
      ensureCaptionsOn();
      startCapture();
      setStatus("Reading the video's captions…");
    } else {
      stopCapture();
      setStatus("Coach off — nothing is read");
    }
  });

  shadow.querySelector(".x").addEventListener("click", () => {
    window.open(`${backend}/?as=learner`, "_blank", "noopener");
  });

  const askInput = shadow.querySelector(".q input");
  const askBtn = shadow.querySelector(".q button");
  const ansEl = shadow.querySelector(".ans");

  async function ask() {
    const query = askInput.value.trim();
    if (!query) return;
    askBtn.disabled = true;
    ansEl.innerHTML = '<p class="at">Thinking…</p>';
    try {
      const r = await fetch(`${backend}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, uid: "learner", video_id: getVideoId(),
                               timestamp: getCurrentTimestamp() }),
      });
      const data = await r.json();
      const steps = (data.logs || []).map((l) => `<li>${bold(escapeHtml(l))}</li>`).join("");
      ansEl.innerHTML = `<details><summary>Agent pipeline (${(data.logs || []).length} steps)</summary>
        <ol>${steps}</ol></details><p class="at"></p>`;
      ansEl.querySelector(".at").textContent = data.final_answer || "No answer.";
    } catch {
      ansEl.innerHTML = '<p class="at">Backend unreachable — try again.</p>';
    }
    askBtn.disabled = false;
    askInput.value = "";
  }
  askBtn.addEventListener("click", ask);
  askInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ask();
  });
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Log lines arrive with **emphasis**; escaping runs first, so only this
// transform can add markup.
function bold(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

// ── Caption reader: the video's own words, never a microphone ────
const CAPTION_SELECTOR = ".ytp-caption-segment, .caption-window span";
const FLUSH_WORDS = 22;    // ~8 s of lecture speech per memory chunk
const FLUSH_SECONDS = 14;  // ...or send it after this long, so a slow speaker
                           // can't leave a half chunk unsent for a minute
let seenCues = new Set();
let capWords = [];
let capStart = 0;
let capTimer = null;
let capVideo = null;

function videoTime() {
  const v = document.querySelector("video");
  return v && v.readyState ? Math.floor(v.currentTime) : 0;
}

function cueTexts() {
  const v = document.querySelector("video");
  const tracks = v && v.textTracks ? Array.from(v.textTracks) : [];
  const out = [];
  for (const t of tracks) {
    if ((t.kind !== "subtitles" && t.kind !== "captions") || !t.activeCues) continue;
    for (const c of t.activeCues) if (c.text && c.text.trim()) out.push(c.text.trim());
  }
  if (out.length) return out;
  for (const node of document.querySelectorAll(CAPTION_SELECTOR)) {
    const text = (node.textContent || "").trim();
    if (text) out.push(text);
  }
  return out;
}

function ensureCaptionsOn() {
  const v = document.querySelector("video");
  for (const t of (v && v.textTracks ? Array.from(v.textTracks) : [])) {
    if ((t.kind === "subtitles" || t.kind === "captions") && t.mode === "disabled") {
      try { t.mode = "hidden"; } catch { /* the player owns this track */ }
    }
  }
  const off = document.querySelector(".ytp-subtitles-button[aria-pressed='false']");
  if (off) off.click();
}

function captureTick() {
  const id = getVideoId();
  if (id !== capVideo) {           // YouTube swaps videos without reloading
    capVideo = id;
    seenCues = new Set();
    capWords = [];
    capStart = 0;
  }
  const v = document.querySelector("video");
  if (!v) return;
  if (v.paused) {
    // A pause is the student stopping to think — that's when they want the
    // answer, so release whatever is buffered instead of holding it back.
    if (capWords.length) sendCaptions();
    return;
  }
  let fresh = false;
  for (const text of cueTexts()) {
    const key = text.toLowerCase();
    if (seenCues.has(key)) continue;
    seenCues.add(key);
    if (seenCues.size > 400) seenCues = new Set([key]);
    if (!capStart) capStart = videoTime();
    capWords.push(text);
    fresh = true;
  }
  if (fresh) setStatus(`Reading captions · ${formatTimestamp(capStart)}`);
  if (!capWords.length) return;
  const words = capWords.join(" ").split(/\s+/).length;
  const waiting = videoTime() - capStart;
  if (words >= FLUSH_WORDS || (words >= 6 && waiting >= FLUSH_SECONDS)) sendCaptions();
}

async function sendCaptions() {
  if (!capWords.length) return;
  const text = capWords.join(" ").replace(/\s+/g, " ").trim();
  const from = capStart;
  const to = Math.max(videoTime(), from + 1);
  capWords = [];
  capStart = 0;
  try {
    await fetch(`${backend}/api/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, uid: "learner", video_id: getVideoId(),
                             source: "youtube-captions", start_time: from, end_time: to }),
    });
    setStatus(`Sent ${text.split(/\s+/).length} words from ${formatTimestamp(from)}`);
  } catch {
    setStatus("Backend unreachable — that chunk was not sent");
  }
}

function startCapture() {
  if (capTimer) return;
  capTimer = setInterval(captureTick, 500);
}

function stopCapture() {
  clearInterval(capTimer);
  capTimer = null;
  sendCaptions();
}

function render() {
  badge.textContent = String(queue.length);
  badge.style.display = queue.length ? "grid" : "none";
  const list = shadow.querySelector(".l");
  if (!queue.length) {
    list.innerHTML = '<div class="e">No cards yet.</div>';
    return;
  }
  list.innerHTML = "";
  for (const card of [...queue].reverse()) {
    const el = document.createElement("div");
    el.className = "c";
    const quote = (card.grounded_in || [])[0] || "";
    const steps = (card.trace || []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
    el.innerHTML = `<b></b><p></p>${quote ? "<i></i>" : ""}
      ${steps ? `<details><summary>How this card was made</summary><ol>${steps}</ol></details>` : ""}
      <div class="a"><button class="g">Got it</button><button class="d">Not now</button></div>`;
    el.querySelector("b").textContent = card.term;
    el.querySelector("p").textContent = card.explanation;
    if (quote) el.querySelector("i").textContent = `From the video: ${quote}`;
    const drop = () => { queue.splice(queue.indexOf(card), 1); render(); };
    el.querySelector(".d").addEventListener("click", drop);
    el.querySelector(".g").addEventListener("click", async () => {
      await fetch(`${backend}/api/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: "learner", term: card.term, explanation: card.explanation }),
      });
      drop();
    });
    list.appendChild(el);
  }
}

// ── Card feed ────────────────────────────────────────────────────
async function poll() {
  try {
    const r = await fetch(`${backend}/api/proactive?uid=learner`);
    const data = await r.json();
    if (data.cards?.length) {
      queue.push(...data.cards);
      while (queue.length > 12) queue.shift();
      render();
    }
  } catch {
    /* backend asleep or offline — the bubble just stays quiet */
  }
}

function start() {
  if (!document.body || getVideoId() === null) return;
  mount();
  poll();
  setInterval(poll, 2500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
