"""
main.py — FastAPI backend for the AI Learning Copilot.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from agents import run_workflow

# ── App Setup ────────────────────────────────────────────────────
app = FastAPI(title="AI Learning Copilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ── Models ───────────────────────────────────────────────────────
class QueryRequest(BaseModel):
    query: str
    video_id: str | None = None
    timestamp: str | None = None


# ── Health Check ─────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Main Endpoint ────────────────────────────────────────────────
@app.post("/api/query")
async def handle_query(req: QueryRequest):
    """Run the multi-agent workflow and return logs + answer."""
    print(f"[QUERY] Received: '{req.query}' | video: {req.video_id} | time: {req.timestamp}")
    result = run_workflow(req.query, req.video_id, req.timestamp)
    print(f"[DONE] Workflow complete - {len(result['logs'])} log entries.")
    return result
