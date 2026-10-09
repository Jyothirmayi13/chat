"""
db_setup.py — Creates Qdrant collections and ingests mock transcript data.
"""

from qdrant_client import models
from config import qdrant_client as client


# ── Collection Setup ─────────────────────────────────────────────
def create_collections():
    """Create the two required Qdrant collections (vector size=3)."""
    for name in ["video_transcripts", "personal_vault"]:
        client.recreate_collection(
            collection_name=name,
            vectors_config=models.VectorParams(
                size=3, distance=models.Distance.COSINE
            ),
        )
    # Create payload indexes for fast filtered lookups in retriever_agent
    client.create_payload_index(
        collection_name="video_transcripts",
        field_name="video_id",
        field_schema="keyword",
    )
    client.create_payload_index(
        collection_name="video_transcripts",
        field_name="start_time",
        field_schema="integer",
    )
    client.create_payload_index(
        collection_name="video_transcripts",
        field_name="end_time",
        field_schema="integer",
    )
    print("[OK] Collections created: video_transcripts, personal_vault")


# ── Mock Ingestion (syntax from init_snippets.py) ────────────────
def ingest_mock_transcript():
    """Insert mock transcript chunks into 'video_transcripts'."""
    client.upload_collection(
        collection_name="video_transcripts",
        ids=[1, 2, 3, 4],
        payload=[
            {"text": "Neural networks are inspired by biological neurons.",
             "start_time": "00:00", "end_time": "00:30"},
            {"text": "Backpropagation adjusts weights using gradient descent.",
             "start_time": "00:30", "end_time": "01:00"},
            {"text": "Overfitting occurs when a model memorizes training data.",
             "start_time": "01:00", "end_time": "01:30"},
            {"text": "Regularization techniques like dropout prevent overfitting.",
             "start_time": "01:30", "end_time": "02:00"},
        ],
        vectors=[
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
            [0.7, 0.8, 0.9],
            [0.3, 0.6, 0.9],
        ],
        parallel=4,
        max_retries=3,
    )
    print("[OK] Mock transcript data ingested into 'video_transcripts'.")


if __name__ == "__main__":
    create_collections()
    ingest_mock_transcript()
    print("[DONE] Database setup and mock ingestion complete!")
