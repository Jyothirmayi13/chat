"""Replay a spec-exact Omi webhook payload against the local backend.

Omi's realtime transcript stream needs the physical device, so this script
sends the identical JSON shape Omi documents for its two transcript webhooks.
Usage:  py -3.13 omi_replay.py [base_url]
"""
import sys
import time
import uuid

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
UID = "learner"

SEGMENTS = [
    {"text": "so transformers replace recurrence with self attention over the whole sequence",
     "speaker": "s1", "speakerId": 1, "is_user": False, "start": 0.0, "end": 4.2},
    {"text": "each head projects queries keys and values then scales the dot product",
     "speaker": "s1", "speakerId": 1, "is_user": False, "start": 4.2, "end": 9.0},
    {"text": "multi head attention lets the model attend to different representational subspaces",
     "speaker": "s1", "speakerId": 1, "is_user": False, "start": 9.0, "end": 14.5},
]

realtime_payload = [
    {**s, "session_id": "omi-demo"} for s in SEGMENTS[:2]
]

memory_payload = {
    "id": str(uuid.uuid4()),
    "created_at": int(time.time()),
    "started_at": int(time.time()) - 60,
    "finished_at": int(time.time()),
    "transcript_segments": SEGMENTS,
    "structured": {
        "title": "Transformer attention lecture",
        "overview": "Lecture on self attention, scaled dot product and multi head attention.",
        "emoji": "🧠",
        "category": "Lecture",
        "action_items": [],
        "events": [],
    },
    "apps_response": None,
    "discarded": False,
    "folder_id": None,
    "folder_name": None,
}

print(f"[replay] target {BASE}")
r = requests.post(f"{BASE}/omi/realtime?uid={UID}&session_id=omi-demo",
                  json=realtime_payload, timeout=30)
print(f"[replay] /omi/realtime      -> {r.status_code} {r.text[:120]}")
time.sleep(2)
r = requests.post(f"{BASE}/omi/conversation?uid={UID}", json=memory_payload, timeout=30)
print(f"[replay] /omi/conversation  -> {r.status_code} {r.text[:120]}")
print("[replay] done - watch the uvicorn window for [proactive] queued")
