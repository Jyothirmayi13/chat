"""
config.py — Central configuration for the Personal Knowledge Vault.
Loads environment variables and initializes shared clients.
"""

import os
from dotenv import load_dotenv
from qdrant_client import QdrantClient
from groq import Groq

# ── Load .env variables ─────────────────────────────────────────
load_dotenv()

QDRANT_URL = os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
LYZR_API_KEY = os.getenv("LYzR_API_KEY")

# ── Model configuration ─────────────────────────────────────────
MODEL_NAME = "llama3-8b-8192"

# ── Initialize Qdrant Client ────────────────────────────────────
def get_qdrant_client() -> QdrantClient:
    """Return a configured Qdrant client instance."""
    return QdrantClient(
        url=QDRANT_URL,
        api_key=QDRANT_API_KEY,
    )


# ── Shared singleton instances ───────────────────────────────────
qdrant_client = get_qdrant_client()
groq_client = Groq(api_key=GROQ_API_KEY)
