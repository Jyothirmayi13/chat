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


def recent_context(uid: str, k: int = 6) -> list[dict]:
    """Most recent transcript chunks (for the proactive watcher)."""
    points, _ = qdrant_client.scroll(
        LECTURE,
        scroll_filter=models.Filter(
            must=[models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
        ),
        limit=k,
        with_payload=True,
    )
    return sorted(
        [p.payload for p in points], key=lambda p: p.get("ts", 0), reverse=True
    )


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


def knows_semantically(uid: str, term: str, threshold: float = 0.78) -> bool:
    """True if a term is already in the vault (semantic, not exact string)."""
    hits = qdrant_client.query_points(
        VAULT,
        query=embed(term),
        query_filter=models.Filter(
            must=[models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
        ),
        limit=1,
    ).points
    return bool(hits) and hits[0].score >= threshold


def store_concept(uid: str, concept: str, explanation: str, mastery: int = 1):
    """Save or refresh a learned concept in the vault."""
    existing = qdrant_client.query_points(
        VAULT,
        query=embed(concept),
        query_filter=models.Filter(
            must=[models.FieldCondition(key="uid", match=models.MatchValue(value=uid))]
        ),
        limit=1,
    ).points
    if existing and existing[0].score >= 0.9:
        pid = existing[0].id
        prev = existing[0].payload.get("mastery", 0)
        mastery = min(5, prev + 1)
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
                    "next_review": int(time.time()) + 86400,
                },
            )
        ],
    )


def due_for_review(uid: str, k: int = 10) -> list[dict]:
    """Concepts whose spaced-repetition review window has passed."""
    points, _ = qdrant_client.scroll(
        VAULT,
        scroll_filter=models.Filter(
            must=[
                models.FieldCondition(key="uid", match=models.MatchValue(value=uid)),
                models.FieldCondition(key="next_review", range=models.Range(lte=int(time.time()))),
            ]
        ),
        limit=k,
        with_payload=True,
    )
    return [p.payload for p in points]


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
