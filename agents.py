"""
agents.py — Lyzr multi-agent orchestration over shared Qdrant memory.

Manager-driven pipeline with observable, step-by-step logs:

  Reactive:  Router -> Retriever (Qdrant) -> Tutor (Lyzr, personalized) -> Librarian
  Proactive: Watcher -> Gap Detector (Lyzr) -> Tutor (Lyzr) -> pending cards

Agents share the same Qdrant collections, which is what makes the whole
system one connected memory loop instead of isolated chat calls.
"""

import json
import re

import memory
from lyzr_client import call_agent


def _fmt_context(chunks: list[dict]) -> str:
    return "\n".join(f"- {c.get('text', '')[:400]}" for c in chunks) or "none"


def _extract_json_array(text: str) -> list:
    """Pull the first JSON array out of an LLM response."""
    match = re.search(r"\[.*?\]", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    # Fallback: comma/newline separated plain text.
    cleaned = re.sub(r"[\"'\[\]]", " ", text)
    return [t.strip() for t in re.split(r"[,\n]", cleaned) if t.strip()]


# ── Reactive pipeline (learner asks a question) ─────────────────
def run_workflow(query: str, uid: str, video_id: str | None = None,
                 timestamp: str | None = None) -> dict:
    logs = []

    logs.append(f"🧭 **Manager:** Routing query for learner `{uid}`...")
    logs.append(
        "🧭 **Router:** "
        + ("Lecture-grounded (video context found)"
           if video_id else "Open-world (no lecture context)")
    )

    logs.append("🔍 **Retriever Agent:** Semantic search over lecture memory...")
    chunks = memory.recall_context(uid, query, k=4, video_id=video_id)
    logs.append(f"✅ Retriever → {len(chunks)} grounded chunk(s).")

    known = [c["concept"] for c in memory.known_concepts(uid)]
    logs.append(f"📚 **Librarian (read):** {len(known)} known concepts as anchor vocabulary.")

    logs.append("🧠 **Tutor Agent:** Generating personalized explanation via Lyzr...")
    message = (
        f"CONTEXT (transcript snippets):\n{_fmt_context(chunks)}\n\n"
        f"CONCEPTS THE LEARNER ALREADY KNOWS:\n{', '.join(known[:40]) or 'none'}\n\n"
        f"QUESTION: {query}\n\n"
        "Explain in max 3 short sentences. When possible, anchor new ideas to "
        "concepts from the learner's known list. No preamble."
    )
    answer = call_agent("tutor", uid, message)
    logs.append("✅ Tutor done → explanation ready.")

    logs.append("💾 **Librarian Agent:** Saving concept to knowledge vault...")
    concept = _extract_term(query)
    if concept:
        memory.store_concept(uid, concept, answer, mastery=2)
        logs.append(f"✅ Saved '{concept}' to vault.")

    return {"logs": logs, "final_answer": answer, "context": chunks}


def _extract_term(query: str) -> str | None:
    """Best-effort: strip 'what is / explain' wrappers to get the term."""
    q = query.strip().rstrip("?.")
    m = re.match(
        r"(?:what|who)\s+is\s+(?:a\s+|an\s+|the\s+)?(.+)|"
        r"(?:explain|define)\s+(?:the\s+)?(.+)",
        q, re.IGNORECASE,
    )
    if m:
        return (m.group(1) or m.group(2)).strip().lower()
    return q.lower() if len(q.split()) <= 4 else None


# ── Proactive pipeline (detect gaps in fresh lecture speech) ────
def detect_gaps(uid: str, transcript_text: str, video_id: str | None = None) -> list[dict]:
    """Find terms this learner likely won't know and explain them before asked."""
    known = [c["concept"] for c in memory.known_concepts(uid)]

    gap_message = (
        f"LECTURE TRANSCRIPT:\n{transcript_text[:1500]}\n\n"
        f"TERMS THE LEARNER ALREADY KNOWS:\n{', '.join(known[:60]) or 'none'}\n\n"
        "List up to 3 technical terms/names in the transcript that the learner "
        "does NOT know (not in their list, and not trivial words like "
        "'training', 'data', 'model'). "
        "Respond ONLY with a JSON array of term strings, e.g. [\"term1\", \"term2\"]."
    )
    raw = call_agent("gap", uid, gap_message)
    print(f"[gap-detector] raw Lyzr reply: {raw[:300]}")
    terms = _extract_json_array(raw)
    terms = [t for t in terms if isinstance(t, str) and 1 < len(t) <= 60
             and len(t.split()) <= 5]

    cards = []
    for term in terms[:3]:
        if memory.knows_semantically(uid, term):
            continue  # already in vault — not a gap
        chunks = memory.recall_context(uid, term, k=2, video_id=video_id)
        explain_message = (
            f"CONTEXT (transcript):\n{_fmt_context(chunks)}\n\n"
            f"LEARNER KNOWS:\n{', '.join(known[:40]) or 'none'}\n\n"
            f"TERM: {term}\n\n"
            "Give a 2-sentence plain explanation a course learner can use "
            "immediately. First sentence = what it is, second = why it matters here."
        )
        explanation = call_agent("tutor", uid, explain_message)
        cards.append({
            "term": term,
            "explanation": explanation,
            "grounded_in": [c.get("text", "")[:160] for c in chunks],
        })
    print(f"[gap-detector] {len(terms)} candidate term(s) -> {len(cards)} card(s) built")
    return cards


# ── Review scheduling ───────────────────────────────────────────
def review_digest(uid: str) -> list[dict]:
    """Concepts whose spaced-repetition window is due — feeds the review view."""
    return memory.due_for_review(uid)
