"""
config.py — Central configuration and shared clients.

Loads environment variables (never commit keys) and exposes singletons used
across the backend: the Qdrant client, the local embedding model, and the
Lyzr agent settings.
"""

import os
from dotenv import load_dotenv
from qdrant_client import QdrantClient

load_dotenv()

# ── Lyzr ────────────────────────────────────────────────────────
LYZR_API_KEY = os.getenv("LYZR_API_KEY", "")
LYZR_AGENT_ID = os.getenv("LYZR_AGENT_ID", "")
LYZR_TUTOR_AGENT_ID = os.getenv("LYZR_TUTOR_AGENT_ID", "")
LYZR_GAP_AGENT_ID = os.getenv("LYZR_GAP_AGENT_ID", "")
LYZR_VAULT_AGENT_ID = os.getenv("LYZR_VAULT_AGENT_ID", "")
LYZR_BASE_URL = os.getenv(
    "LYZR_BASE_URL", "https://agent-prod.studio.lyzr.ai/v3/inference/chat/"
)

# ── Qdrant ──────────────────────────────────────────────────────
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY") or None

# ── Identity ────────────────────────────────────────────────────
DEFAULT_UID = os.getenv("DEFAULT_UID", "learner")

# ── Omi notifications ───────────────────────────────────────────
OMI_APP_ID = os.getenv("OMI_APP_ID", "")
OMI_APP_SECRET = os.getenv("OMI_APP_SECRET", "")

# Comma-separated phrases. Any transcript chunk containing one is discarded
# before it reaches Qdrant or Lyzr — the escape hatch for "my mic is open".
DROP_WORDS = [w.strip().lower() for w in os.getenv("DROP_WORDS", "").split(",") if w.strip()]

# Embedding model: BAAI/bge-small-en-v1.5 -> 384-dim vectors.
EMBED_MODEL = "BAAI/bge-small-en-v1.5"
VECTOR_SIZE = 384

def _make_qdrant() -> QdrantClient:
    """Use the configured server; fall back to embedded disk storage.

    The fallback is logged and recorded in QDRANT_MODE because an embedded
    store looks identical to a working server until the container restarts
    and silently drops the learner's vault.
    """
    global QDRANT_MODE
    try:
        client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY, timeout=10)
        client.get_collections()
        QDRANT_MODE = "server"
        return client
    except Exception as exc:
        print(f"[config] Qdrant server unusable ({exc!r}) — using embedded ./qdrant_data")
        return QdrantClient(path="./qdrant_data")


QDRANT_MODE = "embedded"
qdrant_client = _make_qdrant()
