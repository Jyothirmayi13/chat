/**
 * content.js — Injected into YouTube pages via manifest content_scripts.
 * Extracts the current video ID and playback timestamp on demand.
 */

// ── Extract Video ID from the URL query string ──────────────────
function getVideoId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("v") || null;
}

// ── Format seconds into "MM:SS" string ──────────────────────────
function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// ── Get current playback time from the <video> element ──────────
function getCurrentTimestamp() {
  const video = document.querySelector("video");
  if (!video || video.readyState === 0) return null;
  return formatTimestamp(video.currentTime);
}

// ── Listen for messages from popup.js ───────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_YOUTUBE_DATA") {
    const videoId = getVideoId();
    const timestamp = getCurrentTimestamp();

    sendResponse({
      video_id: videoId,
      timestamp: timestamp,   // "MM:SS" or null
      success: !!videoId,   // false if not on a watch page
    });
  }
  // Return true to keep the message channel open for async responses
  return true;
});
