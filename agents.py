"""
agents.py — Multi-agent workflow with deterministic routing and Groq LLM.
"""

from qdrant_client import models
from config import groq_client, qdrant_client, MODEL_NAME


# ── LLM helper ──────────────────────────────────────────────────
def _ask_llm(prompt: str) -> str:
    """Send a prompt to Groq and return the response text."""
    response = groq_client.chat.completions.create(
        model=MODEL_NAME,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=300,
    )
    return response.choices[0].message.content


# ── Agent 1: Listener ────────────────────────────────────────────
def listener_agent(query: str, timestamp: str | None) -> str:
    """Parse and format the user's query with timestamp context."""
    ts = timestamp or "N/A"
    return f"Explain '{query}' around timestamp [{ts}]."


# ── Agent 2: Retriever (real Qdrant search) ─────────────────────
def _parse_timestamp(ts: str) -> int:
    """Convert 'MM:SS' string to total seconds."""
    parts = ts.split(":")
    return int(parts[0]) * 60 + int(parts[1]) if len(parts) == 2 else 0


# Sentinel value returned when no transcript chunk is found.
NO_TRANSCRIPT_FOUND = "NO_TRANSCRIPT_FOUND"


def retriever_agent(video_id: str | None, timestamp: str | None) -> str:
    """Query Qdrant for the transcript chunk matching video + time.

    Returns the transcript text on success, or NO_TRANSCRIPT_FOUND when
    no matching chunk exists (missing captions, out-of-bounds timestamp,
    or Qdrant errors).  This prevents downstream agents from crashing.
    """
    if not video_id or not timestamp:
        return NO_TRANSCRIPT_FOUND

    seconds = _parse_timestamp(timestamp)
    try:
        results = qdrant_client.scroll(
            collection_name="video_transcripts",
            scroll_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="video_id",
                        match=models.MatchValue(value=video_id),
                    ),
                    models.FieldCondition(
                        key="start_time",
                        range=models.Range(lte=seconds),
                    ),
                    models.FieldCondition(
                        key="end_time",
                        range=models.Range(gte=seconds),
                    ),
                ]
            ),
            limit=1,
        )
        points = results[0]
        if points:
            text = points[0].payload.get("text", "").strip()
            return text if text else NO_TRANSCRIPT_FOUND
        return NO_TRANSCRIPT_FOUND
    except Exception as e:
        # Log internally but never surface raw errors to the user.
        print(f"[retriever_agent] Qdrant error (falling back): {e}")
        return NO_TRANSCRIPT_FOUND


# ── Agent 3: Tutor (contextual) ─────────────────────────────────
def tutor_agent(parsed_query: str, context: str) -> str:
    """Use Groq to explain a concept based on retrieved context."""
    prompt = (
        f"You are a helpful tutor. Based on this transcript:\n"
        f"'{context}'\n\nAnswer concisely:\n{parsed_query}\n\n"
        "Answer concisely in maximum 2 to 3 sentences. Do not ramble."
    )
    return _ask_llm(prompt)


# ── Agent 3b: Tutor (general / recommendations) ─────────────────
def tutor_agent_general(query: str) -> str:
    """Use Groq to provide recommendations or general answers."""
    prompt = (
        f"The user asked: \"{query}\"\n\n"
        "Provide a helpful answer. If they want video recommendations, "
        "suggest 3 real YouTube videos with titles and brief descriptions.\n\n"
        "Answer concisely in maximum 2 to 3 sentences. Do not ramble."
    )
    return _ask_llm(prompt)


# ── Agent 4: Librarian (mock for now) ────────────────────────────
def librarian_agent(term: str, explanation: str) -> str:
    """Save the term and explanation to the personal vault."""
    return f"Saved '{term}' to your Personal Knowledge Vault."


# ── Orchestrator ─────────────────────────────────────────────────
def run_workflow(query: str, video_id: str | None, timestamp: str | None):
    """Run the multi-agent pipeline, returning logs and final answer."""
    logs = []

    # Step 1: Deterministic routing (no LLM call needed)
    intent = "CONTEXTUAL" if video_id and timestamp else "GENERAL"
    logs.append(f"🤖 **Router:** Classified as **{intent}** (rule-based)")

    # Step 2: Contextual path (Retriever → Tutor)
    if intent == "CONTEXTUAL":
        logs.append("👂 **Listener Agent:** Parsing your query...")
        parsed = listener_agent(query, timestamp)
        logs.append("✅ Listener done.")

        logs.append("🔍 **Retriever Agent:** Searching Qdrant...")
        context = retriever_agent(video_id, timestamp)

        # ── Fallback: no transcript available for this timestamp ──
        if context == NO_TRANSCRIPT_FOUND:
            logs.append(
                "⚠️ Retriever → no transcript chunk found. "
                "Falling back to general knowledge."
            )
            logs.append(
                "🧠 **Tutor Agent (General):** Answering from "
                "general knowledge..."
            )
            answer = tutor_agent_general(query)
            answer += (
                "\n\n(Note: No transcript was available for this "
                "specific timestamp, so I used my general knowledge.)"
            )
            logs.append("✅ Tutor done → general answer ready.")
        else:
            logs.append(
                f"✅ Retriever → {len(context)} chars retrieved."
            )
            logs.append(
                "🧠 **Tutor Agent:** Generating explanation..."
            )
            answer = tutor_agent(parsed, context)
            logs.append("✅ Tutor done → explanation ready.")

    # Step 2: General path (skip Retriever)
    else:
        logs.append("🔍 **Router:** General query — skipping Qdrant.")
        logs.append("🧠 **Tutor Agent:** Generating recommendations...")
        answer = tutor_agent_general(query)
        logs.append("✅ Tutor done → recommendations ready.")

    # Step 3: Librarian
    logs.append("📚 **Librarian Agent:** Saving to your vault...")
    save_msg = librarian_agent(query, answer)
    logs.append(f"✅ {save_msg}")

    return {"logs": logs, "final_answer": answer}
