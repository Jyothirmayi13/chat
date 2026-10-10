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

from fastapi import BackgroundTasks, Body, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import agents
import ingest
import memory
from config import DEFAULT_UID

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


class IngestRequest(BaseModel):
    video_id: str
    uid: str | None = None


def _surface_gaps(uid: str, text: str, video_id: str | None):
    """Run gap detection and queue new cards (runs off the request thread)."""
    try:
        cards = agents.detect_gaps(uid, text, video_id)
    except Exception as e:
        print(f"[proactive] detection failed: {e}")
        return
    with LOCK:
        for card in cards:
            key = card["term"].lower()
            if key in SURFACED[uid]:
                continue
            SURFACED[uid].add(key)
            card["id"] = str(uuidlib.uuid4())
            card["ts"] = time.time()
            PENDING[uid].append(card)
        # Cap the queue so a long lecture can't grow it unbounded.
        while len(PENDING[uid]) > 25:
            PENDING[uid].popleft()
    print(f"[proactive] queued {len(cards)} candidate card(s) for {uid}")


def _lecture_only(segments: list) -> str:
    """Transcript text minus the learner's own speech.

    Omi tags the wearer's voice with is_user. Running gap detection over what
    the learner just asked produces cards labelled "you didn't ask".
    """
    return " ".join(
        s.get("text", "") for s in segments if not s.get("is_user")
    ).strip()


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
    uid = OMI_UID
    segments = payload if isinstance(payload, list) else payload.get("segments", [])
    text = " ".join(s.get("text", "") for s in segments).strip()
    lecture = _lecture_only(segments)
    if text:
        memory.remember_context(uid, text, source="omi-realtime")
    if lecture:
        background.add_task(_surface_gaps, uid, lecture, None)
    return {"status": "ok"}


@app.post("/omi/conversation")
def omi_conversation(background: BackgroundTasks, uid: str = Query(DEFAULT_UID),
                     payload: dict = Body(...)):
    """Finished conversation: full transcript + structured summary."""
    uid = OMI_UID
    if payload.get("discarded"):
        return {"status": "skipped"}
    segments = payload.get("transcript_segments", [])
    transcript = " ".join(s.get("text", "") for s in segments)
    overview = (payload.get("structured") or {}).get("overview", "")
    text = (overview + " " + transcript).strip()
    lecture = _lecture_only(segments)
    if text:
        memory.remember_context(uid, text, source="omi-conversation")
    if lecture:
        background.add_task(_surface_gaps, uid, lecture, None)
    return {"status": "ok"}


# ── Web / PWA endpoints ─────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/transcript")
def api_transcript(req: TranscriptRequest, background: BackgroundTasks):
    """Browser-mic transcript (works on any device, no Omi needed)."""
    uid = req.uid or DEFAULT_UID
    if req.text.strip():
        memory.remember_context(uid, req.text.strip(),
                                video_id=req.video_id, source=req.source)
        background.add_task(_surface_gaps, uid, req.text.strip(), req.video_id)
    return {"status": "ok"}


@app.post("/api/ingest_youtube")
def api_ingest_youtube(req: IngestRequest, background: BackgroundTasks):
    """Index a full lecture (YouTube) into memory, then scan for gaps."""
    uid = req.uid or DEFAULT_UID

    def _job():
        n = ingest.ingest_video(req.video_id, uid)
        if n:
            recent = " ".join(
                c.get("text", "") for c in memory.recent_context(uid, k=3)
            )
            _surface_gaps(uid, recent, req.video_id)

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
    return {"due": agents.review_digest(uid)}


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
