"""
memory.py — Real semantic memory layer on Qdrant.

Two collections share one embedding space (bge-small, 384-dim):

  lecture_context : ambient transcript chunks captured from Omi / YouTube.
                    Retrieved to ground explanations in what was actually said.
  knowledge_vault : concepts the learner already knows, each with a mastery
                    score. Used to (a) detect unknown terms and (b) personalize
                    explanations to vocabulary the learner already trusts.

Every point is scoped by uid so retrieval is per-user (privacy-first friendly).
"""

import time
import uuid

from fastembed import TextEmbedding
from qdrant_client import models

from config import (
    EMBED_MODEL,
    VECTOR_SIZE,
    qdrant_client,
)

LECTURE = "lecture_context"
VAULT = "knowledge_vault"

KNOWN_THRESHOLD = 0.78
# Leitner boxes: days until the next review at each mastery level.
REVIEW_DAYS = {1: 1, 2: 3, 3: 7, 4: 14, 5: 30}

_embedder = TextEmbedding(EMBED_MODEL)


def embed(text: str) -> list[float]:
    """Return a 384-dim vector for a single text."""
    return next(iter(_embedder.embed([text]))).tolist()


def _ensure(collection: str, indexes: dict[str, str]):
    if not qdrant_client.collection_exists(collection):
        qdrant_client.create_collection(
            collection,
            vectors_config=models.VectorParams(
                size=VECTOR_SIZE, distance=models.Distance.COSINE
            ),
        )
    for field, schema in indexes.items():
        try:
            qdrant_client.create_payload_index(collection, field, schema)
        except Exception:
            # Index may already exist; harmless.
            pass


def init_db():
    """Create collections and payload indexes. Safe to call repeatedly."""
    _ensure(
        LECTURE,
        {"uid": "keyword", "video_id": "keyword", "ts": "integer"},
    )
    _ensure(
        VAULT,
        {"uid": "keyword", "concept": "keyword", "next_review": "integer"},
    )


# ── Lecture context ─────────────────────────────────────────────
def remember_context(
    uid: str,
    text: str,
    video_id: str | None = None,
    source: str = "omi",
    start_time: int | None = None,
    end_time: int | None = None,
):
    qdrant_client.upsert(
        LECTURE,
        points=[
            models.PointStruct(
                id=str(uuid.uuid4()),
                vector=embed(text),
                payload={
                    "uid": uid,
                    "text": text,
                    "video_id": video_id,
                    "source": source,
                    "start_time": start_time,
                    "end_time": end_time,
                    "ts": int(time.time()),
                },
            )
        ],
    )


def recall_context(uid: str, query: str, k: int = 4, video_id: str | None = None) -> list[dict]:
    """Semantic search over lecture context, scoped to the user."""
    must = [models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
    if video_id:
        must.append(
            models.FieldCondition(key="video_id", match=models.MatchValue(value=video_id))
        )
    hits = qdrant_client.query_points(
        LECTURE,
        query=embed(query),
        query_filter=models.Filter(must=must),
        limit=k,
    ).points
    return [h.payload for h in hits]


# ── Knowledge vault ─────────────────────────────────────────────
def known_concepts(uid: str, limit: int = 500) -> list[dict]:
    """All concepts the learner has stored, with mastery + review metadata."""
    points, _ = qdrant_client.scroll(
        VAULT,
        scroll_filter=models.Filter(
            must=[models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
        ),
        limit=limit,
        with_payload=True,
    )
    return [p.payload for p in points]


def closest_known(uid: str, term: str) -> tuple[str | None, float]:
    """Nearest concept already in the learner's vault, with its cosine score."""
    hits = qdrant_client.query_points(
        VAULT,
        query=embed(term),
        query_filter=models.Filter(
            must=[models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
        ),
        limit=1,
    ).points
    if not hits:
        return None, 0.0
    return hits[0].payload.get("concept"), hits[0].score


def knows_semantically(uid: str, term: str, threshold: float = KNOWN_THRESHOLD) -> bool:
    """True if a term is already in the vault (semantic, not exact string)."""
    return closest_known(uid, term)[1] >= threshold


def _due_after(mastery: int) -> int:
    return int(time.time()) + REVIEW_DAYS[max(1, min(5, mastery))] * 86400


def store_concept(uid: str, concept: str, explanation: str, mastery: int = 1) -> int:
    """Save or refresh a learned concept in the vault; returns the new mastery level."""
    concept = concept.strip().lower()
    existing = qdrant_client.query_points(
        VAULT,
        query=embed(concept),
        query_filter=models.Filter(
            must=[models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
        ),
        limit=1,
    ).points
    if existing and existing[0].score >= 0.82:
        pid = existing[0].id
        prev = existing[0].payload.get("mastery", 0)
        mastery = min(5, max(mastery, prev + 1))
        explanation = explanation or existing[0].payload.get("explanation", "")
    else:
        pid = str(uuid.uuid4())

    qdrant_client.upsert(
        VAULT,
        points=[
            models.PointStruct(
                id=pid,
                vector=embed(f"{concept}. {explanation}"),
                payload={
                    "uid": uid,
                    "concept": concept,
                    "explanation": explanation,
                    "mastery": mastery,
                    "learned_ts": int(time.time()),
                    "next_review": _due_after(mastery),
                },
            )
        ],
    )
    return mastery


def grade_review(uid: str, concept: str, remembered: bool) -> dict | None:
    """Leitner step: remembered pushes the next review further out, forgot resets it."""
    concept = concept.strip().lower()
    points, _ = qdrant_client.scroll(
        VAULT,
        scroll_filter=models.Filter(must=[
            models.FieldCondition(key="uid", match=models.MatchValue(value=uid)),
            models.FieldCondition(key="concept", match=models.MatchValue(value=concept)),
        ]),
        limit=1,
        with_payload=True,
    )
    if not points:
        return None
    p = points[0]
    mastery = min(5, p.payload.get("mastery", 1) + 1) if remembered else 1
    update = {"mastery": mastery, "next_review": _due_after(mastery)}
    qdrant_client.set_payload(VAULT, payload=update, points=[p.id])
    return {"concept": concept, **update}


def due_for_review(uid: str, k: int = 10) -> list[dict]:
    """Concepts whose spaced-repetition review window has passed."""
    return [c for c in known_concepts(uid) if c.get("next_review", 0) <= time.time()][:k]


def review_queue(uid: str, k: int = 10) -> list[dict]:
    """Due concepts first, then the soonest upcoming ones, each with days_to_review."""
    now = time.time()
    items = sorted(known_concepts(uid), key=lambda c: c.get("next_review", 0))
    for c in items:
        c["days_to_review"] = round((c.get("next_review", now) - now) / 86400)
    return items[:k]


def forget(uid: str, concept: str) -> bool:
    """Delete a concept from the vault (privacy: user control)."""
    hits = qdrant_client.query_points(
        VAULT,
        query=embed(concept),
        query_filter=models.Filter(
            must=[models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
        ),
        limit=1,
    ).points
    if not hits:
        return False
    qdrant_client.delete(VAULT, points_selector=[hits[0].id])
    return True
