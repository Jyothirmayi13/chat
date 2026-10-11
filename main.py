"""
main.py — FastAPI backend: Omi webhooks, proactive engine, PWA API.

Execution loop:
  Omi (voice) -> /omi/* -> memory (Qdrant) -> agents (Lyzr) -> PWA card.
The PWA also posts to /api/transcript so it works on any device even when
the Omi app is not streaming (web-mic fallback).
"""

import os
import threading
import time
import uuid as uuidlib
from collections import defaultdict, deque

import requests
from fastapi import BackgroundTasks, Body, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import agents
import ingest
import memory
from config import (DEFAULT_UID, DROP_WORDS, OMI_APP_ID, OMI_APP_SECRET,
                    QDRANT_MODE)

app = FastAPI(title="LearnLoop — Voice-first Learning Copilot")

# Omi rewrites ?uid= with its own internal account id, so webhook traffic must
# be pinned to the learner identity the PWA polls as. Override with OMI_UID.
OMI_UID = os.getenv("OMI_UID") or DEFAULT_UID

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory pending queue of proactive cards per user (drained by the PWA).
PENDING: dict[str, deque] = defaultdict(deque)
# Terms already surfaced per user, so we never spam the same card twice.
SURFACED: dict[str, set] = defaultdict(set)
# No audio is analysed until the learner flips the coach on. Off by default.
ACTIVE: dict[str, bool] = {}
# Pinned learner uid -> the real Omi account id, needed to address notifications.
OMI_ACCOUNT: dict[str, str] = {}
LOCK = threading.Lock()


class QueryRequest(BaseModel):
    query: str
    uid: str | None = None
    video_id: str | None = None
    timestamp: str | None = None


class TranscriptRequest(BaseModel):
    text: str
    uid: str | None = None
    video_id: str | None = None
    source: str = "web"
    start_time: int | None = None
    end_time: int | None = None


class IngestRequest(BaseModel):
    video_id: str
    uid: str | None = None


def _surface_gaps(uid: str, text: str, video_id: str | None,
                  trace: list[str] | None = None, notify_uid: str | None = None):
    """Run gap detection and queue new cards (runs off the request thread)."""
    if not ACTIVE.get(uid, False):
        print(f"[coach] off for {uid} — no audio analysed")
        return
    try:
        cards = agents.detect_gaps(uid, text, video_id, trace)
    except Exception as e:
        print(f"[proactive] detection failed: {e}")
        return
    fresh = []
    with LOCK:
        for card in cards:
            key = card["term"].lower()
            if key in SURFACED[uid]:
                continue
            SURFACED[uid].add(key)
            card["id"] = str(uuidlib.uuid4())
            card["ts"] = time.time()
            fresh.append(card)
    if notify_uid and OMI_APP_ID and OMI_APP_SECRET:
        for card in fresh:
            sent = _notify_omi(notify_uid, card)
            card["trace"].append("Omi notification pushed to your phone" if sent
                                 else "Omi notification failed (card still queued)")
    with LOCK:
        PENDING[uid].extend(fresh)
        # Cap the queue so a long lecture can't grow it unbounded.
        while len(PENDING[uid]) > 25:
            PENDING[uid].popleft()
    print(f"[proactive] queued {len(fresh)} new card(s) for {uid}")


def _blocked(text: str) -> bool:
    """True if the chunk contains a phrase the learner marked as private."""
    low = text.lower()
    return any(w in low for w in DROP_WORDS)


def _lecture_only(segments: list) -> str:
    """Transcript text minus the learner's own speech.

    Omi tags the wearer's voice with is_user. Running gap detection over what
    the learner just asked produces cards labelled "you didn't ask".
    """
    return " ".join(
        s.get("text", "") for s in segments if not s.get("is_user")
    ).strip()


def _intake(uid: str, text: str, lecture: str, source: str,
            video_id: str | None, background: BackgroundTasks,
            notify_uid: str | None = None,
            span: tuple[int | None, int | None] = (None, None)):
    """Store lecture context and queue gap detection — unless marked private."""
    if not text or _blocked(text):
        if _blocked(text):
            print(f"[privacy] chunk dropped for {uid} ({source})")
        return
    start_time, end_time = span
    memory.remember_context(uid, text, source=source, video_id=video_id,
                            start_time=start_time, end_time=end_time)
    if lecture and ACTIVE.get(uid, False):
        trace = [f"{source}: {len(lecture.split())} lecture word(s) received"]
        if len(lecture) < len(text):
            trace.append("Your own speech (is_user) kept out of gap detection")
        if start_time is not None:
            trace.append(f"Spoken at {start_time // 60}:{start_time % 60:02d} in the video")
        trace.append(f"Qdrant lecture_context: chunk embedded + stored (uid={uid})")
        background.add_task(_surface_gaps, uid, lecture, video_id, trace, notify_uid)


def _notify_omi(omi_uid: str, card: dict) -> bool:
    """Push a card to the learner's phone through Omi's notification API."""
    message = f"💡 {card['term']}: {card['explanation']}"[:400]
    try:
        r = requests.post(
            f"https://api.omi.me/v2/integrations/{OMI_APP_ID}/notification",
            params={"uid": omi_uid, "message": message},
            headers={"Authorization": f"Bearer {OMI_APP_SECRET}"},
            timeout=10,
        )
        print(f"[omi-notify] {card['term']!r} -> {r.status_code}")
        return r.ok
    except requests.RequestException as e:
        print(f"[omi-notify] failed: {e}")
        return False


def _omi_account(incoming_uid: str) -> str | None:
    """Remember the Omi account behind the pinned learner, for notifications."""
    if incoming_uid and incoming_uid not in (OMI_UID, DEFAULT_UID):
        OMI_ACCOUNT[OMI_UID] = incoming_uid
    return OMI_ACCOUNT.get(OMI_UID)


# ── Omi webhooks ────────────────────────────────────────────────
@app.get("/omi/realtime")
@app.get("/omi/conversation")
def omi_hook_ping():
    """Omi pings a webhook with GET to verify it before saving the URL."""
    return {"status": "ok", "endpoint": "learnloop"}


@app.post("/omi/realtime")
def omi_realtime(background: BackgroundTasks, uid: str = Query(DEFAULT_UID),
                 session_id: str = Query(""), payload: list | dict = Body(...)):
    """Real-time transcript batches while Omi is listening. Reply fast.
    Omi posts a bare array of segments; some clients wrap it in an object."""
    omi_account = _omi_account(uid)
    uid = OMI_UID
    segments = payload if isinstance(payload, list) else payload.get("segments", [])
    _intake(uid, " ".join(s.get("text", "") for s in segments).strip(),
            _lecture_only(segments), "Omi real-time transcript", None, background,
            omi_account)
    return {"status": "ok"}


@app.post("/omi/conversation")
def omi_conversation(background: BackgroundTasks, uid: str = Query(DEFAULT_UID),
                     payload: dict = Body(...)):
    """Finished conversation: full transcript + structured summary."""
    omi_account = _omi_account(uid)
    uid = OMI_UID
    if payload.get("discarded"):
        return {"status": "skipped"}
    segments = payload.get("transcript_segments", [])
    overview = (payload.get("structured") or {}).get("overview", "")
    _intake(uid, (overview + " " + " ".join(s.get("text", "") for s in segments)).strip(),
            _lecture_only(segments), "Omi conversation event", None, background,
            omi_account)
    return {"status": "ok"}


# ── Web / PWA endpoints ─────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "qdrant": QDRANT_MODE}


@app.post("/api/transcript")
def api_transcript(req: TranscriptRequest, background: BackgroundTasks):
    """Live text into memory: browser mic, or the extension reading captions."""
    uid = req.uid or DEFAULT_UID
    _intake(uid, req.text.strip(), req.text.strip(), req.source,
            req.video_id, background,
            span=(req.start_time, req.end_time))
    return {"status": "ok"}


@app.post("/api/coach")
def api_coach(body: dict = Body(...)):
    """Learner-controlled switch: nothing is analysed until this is on."""
    uid = body.get("uid") or DEFAULT_UID
    ACTIVE[uid] = bool(body.get("on"))
    print(f"[coach] {'ON' if ACTIVE[uid] else 'OFF'} for {uid}")
    return {"status": "ok", "coach": ACTIVE[uid]}


@app.get("/api/coach")
def api_coach_state(uid: str = Query(DEFAULT_UID)):
    return {"coach": ACTIVE.get(uid, False)}


@app.post("/api/ingest_youtube")
def api_ingest_youtube(req: IngestRequest, background: BackgroundTasks):
    """Index a full lecture (YouTube) into memory, then scan for gaps."""
    uid = req.uid or DEFAULT_UID

    def _job():
        chunks = ingest.ingest_video(req.video_id, uid)
        if chunks:
            opening = " ".join(c["text"] for c in chunks[:3])
            trace = [f"YouTube transcript: {len(chunks)} chunk(s) of {req.video_id}",
                     "Qdrant lecture_context: embedded + stored with video_id filter"]
            _surface_gaps(uid, opening, req.video_id, trace)

    background.add_task(_job)
    return {"status": "ingesting", "video_id": req.video_id}


@app.get("/api/proactive")
def api_proactive(uid: str = Query(DEFAULT_UID)):
    """Drain pending proactive explanation cards."""
    with LOCK:
        cards = list(PENDING[uid])
        PENDING[uid].clear()
    return {"cards": cards}


@app.post("/api/query")
def api_query(req: QueryRequest):
    """Reactive ask: full multi-agent pipeline with observable logs."""
    uid = req.uid or DEFAULT_UID
    return agents.run_workflow(req.query, uid, req.video_id, req.timestamp)


@app.post("/api/acknowledge")
def api_acknowledge(body: dict = Body(...)):
    """Learner tapped 'Got it' on a card -> concept enters the vault."""
    uid = body.get("uid") or DEFAULT_UID
    memory.store_concept(uid, body["term"].lower(), body.get("explanation", ""))
    return {"status": "saved", "concept": body["term"]}


@app.get("/api/vault")
def api_vault(uid: str = Query(DEFAULT_UID)):
    return {"concepts": memory.known_concepts(uid)}


@app.get("/api/review")
def api_review(uid: str = Query(DEFAULT_UID)):
    return {"due": agents.review_digest(uid),
            "due_now": len(memory.due_for_review(uid))}


@app.post("/api/review/grade")
def api_review_grade(body: dict = Body(...)):
    """Learner self-grades a due concept; the next review moves accordingly."""
    uid = body.get("uid") or DEFAULT_UID
    result = memory.grade_review(uid, body["concept"], bool(body.get("remembered")))
    return {"status": "ok" if result else "not_found", **(result or {})}


@app.post("/api/known")
def api_known(body: dict = Body(...)):
    """Declare concepts the learner already knows, so they are never flagged."""
    uid = body.get("uid") or DEFAULT_UID
    concepts = [c.strip().lower() for c in body.get("concepts", []) if c.strip()]
    for c in concepts:
        memory.store_concept(uid, c, "", mastery=3)
    return {"status": "saved", "concepts": concepts}


@app.post("/api/forget")
def api_forget(body: dict = Body(...)):
    """Privacy: user-controlled deletion from memory."""
    uid = body.get("uid") or DEFAULT_UID
    return {"removed": memory.forget(uid, body["concept"])}


@app.on_event("startup")
def startup():
    memory.init_db()
    print("[OK] Qdrant collections ready.")


# Serve the PWA (mobile + desktop) from the same origin.
app.mount("/", StaticFiles(directory="pwa", html=True), name="pwa")
