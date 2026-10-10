"""
ingest.py — Fetch real YouTube transcripts and store them as semantic
lecture memory (real bge embeddings via memory.remember_context).

Usage (CLI):  python ingest.py <video_id>
Backend also calls ingest_video() from POST /api/ingest_youtube.
"""

from youtube_transcript_api import YouTubeTranscriptApi

import memory

CHUNK_DURATION = 45  # seconds per memory chunk


def chunk_transcript(entries: list[dict], chunk_sec: int = CHUNK_DURATION) -> list[dict]:
    """Group raw snippets into ~45s time-windowed chunks."""
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
    if current_text.strip():
        chunks.append({
            "text": current_text.strip(),
            "start_time": int(start),
            "end_time": int(entries[-1]["start"] + entries[-1].get("duration", 0)),
        })
    return chunks


def ingest_video(video_id: str, uid: str) -> int:
    """Fetch + chunk + embed + store. Returns number of chunks ingested."""
    try:
        fetched = YouTubeTranscriptApi().fetch(video_id)
        entries = [
            {"text": s.text, "start": s.start, "duration": s.duration}
            for s in fetched.snippets
        ]
    except Exception as e:
        print(f"[ingest] transcript unavailable for {video_id}: {e}")
        return 0

    chunks = chunk_transcript(entries)
    for c in chunks:
        memory.remember_context(
            uid, c["text"], video_id=video_id, source="youtube",
            start_time=c["start_time"], end_time=c["end_time"],
        )
    print(f"[ingest] stored {len(chunks)} chunks for {video_id}")
    return len(chunks)


if __name__ == "__main__":
    import sys
    memory.init_db()
    vid = sys.argv[1] if len(sys.argv) > 1 else "aircAruvnKk"
    n = ingest_video(vid, "learner")
    print(f"[DONE] {n} chunks ingested.")
