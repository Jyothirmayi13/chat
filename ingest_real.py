"""
ingest_real.py — Fetches a real YouTube transcript and ingests it into Qdrant.
"""

import random
from youtube_transcript_api import YouTubeTranscriptApi
from config import qdrant_client as client

# ── Demo video (Andrew Ng: "What is a Neural Network?") ──────────
DEMO_VIDEO_ID = "aircAruvnKk"
CHUNK_DURATION = 45  # seconds per chunk (30-60s range)


def fetch_transcript(video_id: str) -> list[dict]:
    """Fetch transcript snippets from YouTube (v1.2.4 API)."""
    try:
        api = YouTubeTranscriptApi()
        fetched = api.fetch(video_id)
        # Convert FetchedTranscriptSnippet objects to dicts
        return [
            {"text": s.text, "start": s.start, "duration": s.duration}
            for s in fetched.snippets
        ]
    except Exception as e:
        print(f"[ERROR] Could not fetch transcript: {e}")
        return []


def chunk_transcript(entries: list[dict], chunk_sec: int = CHUNK_DURATION):
    """Group transcript entries into time-based chunks."""
    if not entries:
        return []

    chunks, current_text, start = [], "", entries[0]["start"]

    for entry in entries:
        current_text += " " + entry["text"]
        end = entry["start"] + entry.get("duration", 0)

        if (end - start) >= chunk_sec:
            chunks.append({
                "text": current_text.strip(),
                "start_time": int(start),
                "end_time": int(end),
            })
            current_text, start = "", end

    # Flush remaining text
    if current_text.strip():
        chunks.append({
            "text": current_text.strip(),
            "start_time": int(start),
            "end_time": int(entries[-1]["start"] + entries[-1].get("duration", 0)),
        })
    return chunks


def ingest_chunks(video_id: str, chunks: list[dict]):
    """Upload transcript chunks to Qdrant using upload_collection syntax."""
    if not chunks:
        print("[WARN] No chunks to ingest.")
        return

    payload = [{"video_id": video_id, **c} for c in chunks]
    vectors = [[random.random(), random.random(), random.random()]
               for _ in chunks]

    client.upload_collection(
        collection_name="video_transcripts",
        ids=list(range(1, len(chunks) + 1)),
        payload=payload,
        vectors=vectors,
        parallel=4,
        max_retries=3,
    )
    print(f"[OK] Ingested {len(chunks)} chunks for video '{video_id}'.")


if __name__ == "__main__":
    print(f"[INFO] Fetching transcript for: {DEMO_VIDEO_ID}")
    entries = fetch_transcript(DEMO_VIDEO_ID)
    print(f"   - {len(entries)} raw entries fetched.")

    chunks = chunk_transcript(entries)
    print(f"   - {len(chunks)} chunks created.")

    ingest_chunks(DEMO_VIDEO_ID, chunks)
    print("[DONE] Real data ingestion complete!")
