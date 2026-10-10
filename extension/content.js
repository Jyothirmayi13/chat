/**
 * content.js — the floating coach on YouTube watch pages.
 *
 * Two jobs:
 *  1. Expose video id + playback time to popup.js (grounding context).
 *  2. Show a corner bubble that quietly collects proactive cards, so clearing
 *     a doubt never means leaving the video or losing your place.
 */

const HOST = "learnloop-coach";
let backend = "http://localhost:8000";
let shadow = null;
let panel = null;
let badge = null;
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
  shadow.innerHTML = `
    <style>
      .btn{position:relative;width:46px;height:46px;border-radius:50%;border:0;cursor:pointer;
        background:#123a2a;color:#5eead4;font-size:20px;box-shadow:0 4px 18px #0009;
        display:grid;place-items:center}
      .btn.off{background:#1c2333;color:#9aa7bd}
      .n{position:absolute;top:-4px;right:-4px;min-width:19px;height:19px;border-radius:999px;
        background:#f59e0b;color:#1a1204;font-size:11px;font-weight:700;display:none;place-items:center;padding:0 4px}
      .p{position:absolute;bottom:56px;right:0;width:320px;max-height:60vh;overflow:auto;
        background:#0b1020;color:#e6edf3;border:1px solid #ffffff1f;border-radius:14px;
        padding:12px;display:none;font-family:system-ui,sans-serif}
      .p.open{display:block}
      .h{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#f59e0b;margin:0 0 8px}
      .c{border-top:1px solid #ffffff14;padding:10px 0}
      .c b{display:block;color:#7dd3fc;font-size:14px;margin-bottom:4px}
      .c p{margin:0 0 6px;font-size:13px;line-height:1.45}
      .c i{display:block;font-size:11px;color:#8b98ad;margin-bottom:8px}
      .a{display:flex;gap:6px}
      .a button{flex:1;padding:6px;border-radius:8px;border:0;font-size:12px;font-weight:600;cursor:pointer}
      .g{background:#34d399;color:#06251a}
      .d{background:#ffffff12;color:#9aa7bd}
      .e{font-size:12px;color:#8b98ad;text-align:center;padding:14px 0}
    </style>
    <button class="btn off" title="LearnLoop coach">🧠<span class="n"></span></button>
    <div class="p"><p class="h">Proactive · you didn't ask</p><div class="l"><div class="e">No cards yet.</div></div></div>`;

  panel = shadow.querySelector(".p");
  badge = shadow.querySelector(".n");
  shadow.querySelector(".btn").addEventListener("click", () => panel.classList.toggle("open"));
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
    el.innerHTML = `<b></b><p></p>${quote ? "<i></i>" : ""}
      <div class="a"><button class="g">Got it</button><button class="d">Not now</button></div>`;
    el.querySelector("b").textContent = card.term;
    el.querySelector("p").textContent = card.explanation;
    if (quote) el.querySelector("i").textContent = `Heard at ${getCurrentTimestamp() || "?"}: ${quote}`;
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
  setInterval(poll, 5000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
