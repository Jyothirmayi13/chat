"""
lyzr_client.py — Thin REST wrapper around Lyzr Agent Studio.

Every agent created in Studio can be called with the same chat endpoint.
`call_agent` resolves a specialist agent id, falling back to the manager
agent when the specialist is not configured, so the workflow runs even with
a single Studio agent.
"""

import requests

from config import (
    LYZR_API_KEY,
    LYZR_AGENT_ID,
    LYZR_BASE_URL,
    LYZR_GAP_AGENT_ID,
    LYZR_TUTOR_AGENT_ID,
    LYZR_VAULT_AGENT_ID,
)

# role -> env agent id, with manager fallback.
_ROLE_AGENTS = {
    "manager": LYZR_AGENT_ID,
    "gap": LYZR_GAP_AGENT_ID or LYZR_AGENT_ID,
    "tutor": LYZR_TUTOR_AGENT_ID or LYZR_AGENT_ID,
    "vault": LYZR_VAULT_AGENT_ID or LYZR_AGENT_ID,
}


def call_agent(role: str, user_id: str, message: str, session_id: str | None = None) -> str:
    agent_id = _ROLE_AGENTS.get(role) or LYZR_AGENT_ID
    if not (LYZR_API_KEY and agent_id):
        return "[Lyzr not configured] Set LYZR_API_KEY and LYZR_AGENT_ID in .env"

    payload = {
        "user_id": user_id,
        "agent_id": agent_id,
        "session_id": session_id or f"{agent_id}-{user_id}",
        "message": message,
    }
    try:
        r = requests.post(
            LYZR_BASE_URL,
            headers={"Content-Type": "application/json", "x-api-key": LYZR_API_KEY},
            json=payload,
            timeout=60,
        )
        data = r.json()
        return data.get("response") or data.get("answer") or str(data)
    except Exception as e:
        return f"[Lyzr call failed: {e}]"
