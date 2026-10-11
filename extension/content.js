/**
 * content.js — the floating coach, on every page you read.
 *
 * Four jobs:
 *  1. Point-at-a-word: select a term anywhere (paper, docs, blog, video page)
 *     and a chip offers an explanation in place, without leaving the page.
 *  2. On a YouTube watch page, read the video's own caption cues while it
 *     plays, so words arrive correctly spelled and in step with playback.
 *  3. Expose video id + playback time to popup.js (grounding context).
 *  4. Show a corner bubble that quietly collects proactive cards, so clearing
 *     a doubt never means losing your place.
 */

const HOST = "learnloop-coach";
let backend = "https://learnloop-xh10.onrender.com";
let shadow = null;
let panel = null;
let badge = null;
let statusEl = null;
let coachOn = false;
const queue = [];
let chipEl = null;
let popEl = null;
let popBody = null;
let pendingTerm = "";
let pendingPassage = "";
let lastRect = null;
let selTimer = null;
let chipHover = false;

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
      .chip{position:fixed;display:none;align-items:center;gap:5px;background:#0b1020;
        border:1px solid #5eead466;border-radius:9px;padding:6px 10px;font-size:12px;
        font-weight:700;color:#5eead4;cursor:pointer;box-shadow:0 6px 20px #000c;
        font-family:system-ui,sans-serif;z-index:2}
      .chip.on{display:flex}
      .pop{position:fixed;display:none;width:min(340px,86vw);max-height:46vh;overflow:auto;
        background:#0b1020;color:#e6edf3;border:1px solid #ffffff26;border-radius:12px;
        padding:11px 12px;font-size:13px;line-height:1.5;font-family:system-ui,sans-serif;
        box-shadow:0 10px 30px #000c;z-index:3}
      .pop.on{display:block}
      .pop b{display:block;color:#7dd3fc;font-size:14px;margin:0 0 5px;padding-right:16px}
      .pop p{margin:0 0 7px}
      .pop details{margin:0 0 7px}
      .pop summary{font-size:11px;color:#8b98ad;cursor:pointer}
      .pop ol{margin:5px 0 0;padding-left:17px;font-size:11px;color:#8b98ad;line-height:1.5}
      .pop .vs{font-size:11px;color:#7dd3fc;cursor:pointer;text-decoration:underline}
      .pc{position:absolute;top:6px;right:9px;font-size:16px;color:#8b98ad;cursor:pointer}
    </style>
    <button class="btn off" title="LearnLoop coach">🧠<span class="n"></span></button>
    <div class="p">
      <div class="hd"><p class="h">Proactive · you didn't ask</p><span class="x" title="Open the full LearnLoop app">full app ↗</span></div>
      <p class="s"></p>
      <div class="l"><div class="e">No cards yet.</div></div>
      <div class="q"><input type="text" placeholder="Ask about this page" /><button>Ask</button></div>
      <div class="ans"></div>
    </div>
    <div class="chip">💡 Explain in LearnLoop</div>
    <div class="pop"><span class="pc" title="Close">×</span><div class="bd"></div></div>`;

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
      if (getVideoId() !== null) {
        ensureCaptionsOn();
        startCapture();
        setStatus("Reading the video's captions…");
      } else {
        setStatus("Coach on — select any word here for a card");
      }
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

  // Selection chip: the page's own text, read at the moment the learner points
  // at it. Needs no coach switch — selecting a word is already the asking.
  chipEl = shadow.querySelector(".chip");
  popEl = shadow.querySelector(".pop");
  popBody = shadow.querySelector(".pop .bd");
  shadow.querySelector(".pc").addEventListener("click", hidePop);
  // Pressing the chip must not clear the page's selection: the default action
  // of mousedown collapses it, selectionchange then hides the chip, and the
  // click lands on the page underneath instead of here. preventDefault keeps
  // both the selection and the click alive.
  let lastSend = 0;
  const fire = (e) => {
    e.preventDefault();
    if (e.type === "click" && Date.now() - lastSend < 600) return;
    if (!pendingTerm) return;
    lastSend = Date.now();
    sendLookup(pendingTerm, pendingPassage);
  };
  chipEl.addEventListener("mousedown", fire);
  chipEl.addEventListener("click", fire);
  chipEl.addEventListener("mouseenter", () => { chipHover = true; });
  chipEl.addEventListener("mouseleave", () => { chipHover = false; });
  popEl.addEventListener("click", (e) => {
    if (e.target.classList && e.target.classList.contains("vs")) {
      window.open(`${backend}/?as=learner`, "_blank", "noopener");
    }
  });
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("mousedown", (e) => {
    const host = document.getElementById(HOST);
    if (host && (e.target === host || host.contains(e.target))) return;
    hideChip();
  });
  // Hiding on scroll made the chip vanish mid-select on sites that auto-scroll
  // or use sticky headers, so it follows the selection instead of disappearing.
  const follow = () => requestAnimationFrame(reposition);
  window.addEventListener("scroll", follow, true);
  window.addEventListener("resize", follow);
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

// ── Point-at-a-word lookup ───────────────────────────────────────
const MAX_TERM = 120;      // a word or phrase -> one Tutor call, saved to vault
const MAX_PASSAGE = 700;   // longer selections are questions -> the Ask pipeline

function hideChip() {
  if (chipEl) chipEl.classList.remove("on");
}

function hidePop() {
  if (popEl) popEl.classList.remove("on");
}

function placeBelow(el, rect) {
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, rect.left))}px`;
  el.style.top = `${Math.min(Math.max(8, rect.bottom + 8),
                             Math.max(8, window.innerHeight - el.offsetHeight - 8))}px`;
}

function passageAround(node) {
  let el = node && (node.nodeType === Node.TEXT_NODE ? node.parentNode : node);
  let best = "";
  for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 900) break;        // climbed past the paragraph
    best = text;
    if (text.length >= 80) break;        // a sentence or two is enough to ground it
  }
  return best;
}

function onSelectionChange() {
  clearTimeout(selTimer);
  selTimer = setTimeout(checkSelection, 150);
}

function currentRect() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return rect && (rect.width || rect.height || rect.top) ? rect : null;
}

function checkSelection() {
  if (chipHover) return;            // never pull the chip out from under the cursor
  const sel = window.getSelection();
  const term = sel ? sel.toString().replace(/\s+/g, " ").trim() : "";
  if (!term || term.length > MAX_PASSAGE) return hideChip();
  const rect = currentRect();
  if (!rect) return hideChip();
  const node = sel.anchorNode;
  const host = document.getElementById(HOST);
  if (host && node && host.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node)) {
    return hideChip();
  }
  pendingTerm = term;
  pendingPassage = passageAround(node);
  lastRect = rect;
  chipEl.classList.add("on");
  placeBelow(chipEl, rect);
}

function reposition() {
  if (!chipEl || chipHover) return;
  const open = chipEl.classList.contains("on");
  const shown = popEl && popEl.classList.contains("on");
  if (!open && !shown) return;
  const rect = currentRect();
  if (!rect) {
    hideChip();          // the selection is gone, so the chip has no anchor
    return;
  }
  lastRect = rect;
  if (open) placeBelow(chipEl, rect);
  if (shown) placeBelow(popEl, rect);
}

function showPop(html) {
  popBody.innerHTML = html;
  popEl.classList.add("on");
  if (lastRect) placeBelow(popEl, lastRect);
}

function renderPop(title, body, steps) {
  const lines = (steps || []).map((s) => `<li>${bold(escapeHtml(s))}</li>`).join("");
  showPop(`<b>${escapeHtml(title)}</b>
    <p>${escapeHtml(body || "Nothing came back — try again.")}</p>
    ${lines ? `<details><summary>How this was made</summary><ol>${lines}</ol></details>` : ""}
    <span class="vs">Open in the full app</span>`);
}

function heading(term) {
  return term.length > 60 ? `${term.slice(0, 57)}…` : term;
}

async function sendLookup(term, passage) {
  hideChip();
  showPop(`<b>${escapeHtml(heading(term))}</b><p>Explaining…</p>`);
  const path = term.length <= MAX_TERM ? "/api/lookup" : "/api/query";
  const payload = term.length <= MAX_TERM
    ? { term, passage, uid: "learner", video_id: getVideoId() }
    : { query: `Explain this in plain language: "${term}"`, uid: "learner",
        video_id: getVideoId(), timestamp: getCurrentTimestamp() };
  try {
    const r = await fetch(`${backend}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (path === "/api/lookup") {
      const card = data.card || {};
      renderPop(card.term || term, card.explanation, card.trace);
    } else {
      renderPop(heading(term), data.final_answer, data.logs);
    }
  } catch {
    showPop(`<b>${escapeHtml(heading(term))}</b><p>Backend unreachable — try again.</p>`);
  }
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
  // The queue is one-per-uid and first-poller-wins, so a closed bubble that
  // keeps draining it would starve the PWA (and vice versa).
  if (!coachOn) return;
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
  if (!document.body) return;
  mount();
  poll();
  setInterval(poll, 2500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
