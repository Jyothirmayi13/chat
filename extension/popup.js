/**
 * popup.js — Chrome extension popup (progressive enhancement).
 * On a YouTube watch page it attaches the video id + playback time to the
 * question so the answer is grounded in that lecture. The same backend powers
 * the mobile/desktop PWA, so this surface is optional.
 */

const DEFAULT_BACKEND = "https://learnloop-xh10.onrender.com";
let BACKEND_URL = DEFAULT_BACKEND;

// Allow overriding the backend URL (e.g. deployed demo) without editing code.
chrome.storage.sync.get("backend_url", ({ backend_url }) => {
  BACKEND_URL = backend_url || DEFAULT_BACKEND;
});

const sendBtn = document.getElementById("send-btn");
const btnText = document.querySelector(".btn-text");
const btnLoader = document.getElementById("btn-loader");
const queryInput = document.getElementById("query-input");
const micBtn = document.getElementById("mic-btn");
const micIcon = document.getElementById("mic-icon");
const agentLogs = document.getElementById("agent-logs");
const finalAnswer = document.getElementById("final-answer");
const answerContent = document.getElementById("answer-content");
const contextBanner = document.getElementById("context-banner");
const videoInfo = document.getElementById("video-info");

// ── Voice input ──────────────────────────────────────────────────
let recognition = null;
let isListening = false;

function initSpeechRecognition() {
  const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechAPI) { micBtn.disabled = true; return; }
  recognition = new SpeechAPI();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.onresult = (e) => {
    queryInput.value = e.results[0][0].transcript;
    addLog(`🎙️ Voice captured: "${queryInput.value}"`, "success");
  };
  recognition.onend = () => stopListening();
  recognition.onerror = () => stopListening();
}
function startListening() {
  if (!recognition) return;
  isListening = true;
  micIcon.textContent = "🔴";
  recognition.start();
  addLog("🎙️ Listening...", "active");
}
function stopListening() {
  isListening = false;
  micIcon.textContent = "🎙️";
}
micBtn.addEventListener("click", () => (isListening ? recognition.stop() : startListening()));
initSpeechRecognition();

// ── Log helpers ──────────────────────────────────────────────────
function addLog(message, type = "info") {
  const ph = agentLogs.querySelector(".log-placeholder");
  if (ph) ph.remove();
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.innerHTML = message.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  agentLogs.appendChild(entry);
  agentLogs.scrollTop = agentLogs.scrollHeight;
}
function clearUI() {
  agentLogs.innerHTML = "";
  answerContent.textContent = "";
  finalAnswer.classList.add("hidden");
}
function setLoading(isLoading) {
  sendBtn.disabled = isLoading;
  btnText.textContent = isLoading ? "Running..." : "Send";
  btnLoader.classList.toggle("hidden", !isLoading);
}
function showAnswer(text) {
  answerContent.textContent = text;
  finalAnswer.classList.remove("hidden");
}

// ── YouTube context via content.js ───────────────────────────────
async function getYouTubeData() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !tab.url.includes("youtube.com/watch")) {
      return { video_id: null, timestamp: null, success: false };
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_YOUTUBE_DATA" });
    return response || { video_id: null, timestamp: null, success: false };
  } catch {
    return { video_id: null, timestamp: null, success: false };
  }
}

// ── Send handler ─────────────────────────────────────────────────
sendBtn.addEventListener("click", async () => {
  const query = queryInput.value.trim();
  if (!query) return;

  clearUI();
  setLoading(true);

  addLog("🔗 Detecting page context...", "info");
  const yt = await getYouTubeData();
  if (yt.success) {
    addLog(`📺 Grounding on video ${yt.video_id} @ ${yt.timestamp}`, "success");
  } else {
    addLog("📺 Not a watch page — answering from everything you've watched.", "info");
  }

  addLog("🧠 Running Lyzr agent pipeline...", "active");
  try {
    const res = await fetch(`${BACKEND_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        uid: "learner",
        video_id: yt.video_id,
        timestamp: yt.timestamp,
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    (data.logs || []).forEach((line) => addLog(line, "info"));
    showAnswer(data.final_answer || "No response.");
  } catch (err) {
    addLog("❌ Backend offline. Is the server running?", "error");
    showAnswer("⚠️ Set the backend URL (chrome.storage.backend_url) and ensure the server is up.");
  }

  setLoading(false);
});

// ── Auto-detect on popup open ────────────────────────────────────
(async () => {
  const yt = await getYouTubeData();
  if (yt.success) {
    videoInfo.textContent = `YouTube: ${yt.video_id} @ ${yt.timestamp}`;
    contextBanner.classList.remove("hidden");
  }
})();
