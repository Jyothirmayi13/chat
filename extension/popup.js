/**
 * popup.js — Chrome Extension popup logic.
 * Handles voice input (webkitSpeechRecognition), backend calls, and UI updates.
 */

const BACKEND_URL = "http://localhost:8000";

// ── DOM References ──────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════
//  VOICE INPUT — webkitSpeechRecognition
// ═══════════════════════════════════════════════════════════════
let recognition = null;
let isListening = false;

function initSpeechRecognition() {
  const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechAPI) {
    micBtn.title = "Speech recognition not supported";
    micBtn.disabled = true;
    return;
  }
  recognition = new SpeechAPI();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.continuous = false;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    queryInput.value = transcript;
    addLog(`🎙️ Voice captured: "${transcript}"`, "success");
  };

  recognition.onend = () => stopListening();
  recognition.onerror = (e) => {
    addLog(`🎙️ Mic error: ${e.error}`, "info");
    stopListening();
  };
}

function startListening() {
  if (!recognition) return;
  isListening = true;
  micIcon.textContent = "🔴";
  micBtn.classList.add("listening");
  recognition.start();
  addLog("🎙️ Listening... speak now.", "active");
}

function stopListening() {
  isListening = false;
  micIcon.textContent = "🎙️";
  micBtn.classList.remove("listening");
}

micBtn.addEventListener("click", () => {
  if (isListening) {
    recognition.stop();
  } else {
    startListening();
  }
});

initSpeechRecognition();

// ═══════════════════════════════════════════════════════════════
//  AGENT LOG HELPERS
// ═══════════════════════════════════════════════════════════════
function addLog(message, type = "info") {
  const placeholder = agentLogs.querySelector(".log-placeholder");
  if (placeholder) placeholder.remove();

  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = message;
  agentLogs.appendChild(entry);
  agentLogs.scrollTop = agentLogs.scrollHeight;
}

function clearUI() {
  agentLogs.innerHTML = "";
  answerContent.textContent = "";
  finalAnswer.classList.add("hidden");
}

// ── UI State Helpers ────────────────────────────────────────────
function setLoading(isLoading) {
  sendBtn.disabled = isLoading;
  btnText.textContent = isLoading ? "Running..." : "Send";
  btnLoader.classList.toggle("hidden", !isLoading);
}

function showAnswer(text) {
  answerContent.textContent = text;
  finalAnswer.classList.remove("hidden");
}

// ═══════════════════════════════════════════════════════════════
//  BACKEND CALL
// ═══════════════════════════════════════════════════════════════
async function sendToBackend(query, videoId, timestamp) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, video_id: videoId, timestamp }),
    });
    if (!res.ok) {
      throw new Error(`Server responded with status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    // Distinguish network failures from HTTP errors
    if (err instanceof TypeError && err.message.includes("fetch")) {
      throw new Error("BACKEND_OFFLINE");
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
//  SEND HANDLER
// ═══════════════════════════════════════════════════════════════
sendBtn.addEventListener("click", async () => {
  const query = queryInput.value.trim();
  if (!query) return;

  clearUI();
  setLoading(true);

  // Step 1: Request real YouTube data from content.js
  addLog("🔗 Checking YouTube context...", "info");
  const ytData = await getYouTubeData();

  // Use real data or fall back to dummy values
  const videoId = ytData.video_id || "dummy_video_123";
  const timestamp = ytData.timestamp || "00:30";

  if (ytData.success) {
    addLog(`📺 Video: ${videoId} @ ${timestamp}`, "success");
  } else {
    addLog("📺 No YouTube video detected — using demo mode.", "info");
  }

  // Step 2: Call backend with clean, high-level status logs
  addLog("🔍 Searching video context...", "active");
  try {
    const data = await sendToBackend(query, videoId, timestamp);

    // Step 3: Show generation status (ignore raw data.logs)
    addLog("🧠 Generating answer...", "success");

    // Step 4: Display final answer
    showAnswer(data.final_answer || "No response received.");
  } catch (err) {
    if (err.message === "BACKEND_OFFLINE") {
      addLog("❌ Could not connect to the backend server.", "error");
      showAnswer(
        "⚠️ Backend is offline. Please ensure the Python server " +
        "is running on port 8000."
      );
    } else {
      addLog(`❌ Error: ${err.message}`, "error");
      showAnswer(
        "Something went wrong while processing your request. " +
        "Please try again."
      );
    }
  }

  setLoading(false);
});

// ═══════════════════════════════════════════════════════════════
//  YOUTUBE DATA (via content.js)
// ═══════════════════════════════════════════════════════════════
async function getYouTubeData() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true, currentWindow: true,
    });
    // Only message content.js if we're on a YouTube watch page
    if (!tab.url || !tab.url.includes("youtube.com/watch")) {
      return { video_id: null, timestamp: null, success: false };
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_YOUTUBE_DATA",
    });
    return response || { video_id: null, timestamp: null, success: false };
  } catch {
    // content.js not loaded or tab not accessible
    return { video_id: null, timestamp: null, success: false };
  }
}

// ── Auto-detect YouTube on popup open ───────────────────────────
(async () => {
  const ytData = await getYouTubeData();
  if (ytData.success) {
    videoInfo.textContent = `YouTube: ${ytData.video_id} @ ${ytData.timestamp}`;
    contextBanner.classList.remove("hidden");
  }
})();
