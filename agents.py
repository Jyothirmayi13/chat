"""
agents.py — Lyzr multi-agent orchestration over shared Qdrant memory.

The backend is the orchestrator; each reasoning step is a separate,
specialised Lyzr agent with its own system prompt:

  Reactive:  Qdrant recall -> Lyzr Tutor (personalised) -> Qdrant vault write
  Proactive: Qdrant store -> Lyzr Gap Detector -> Qdrant vault check
             -> Lyzr Tutor -> pending card

Every step is logged so the workflow is observable end to end, and the logs
name the agent that actually served the step.
"""

import json
import re
import time

import memory
from lyzr_client import call_agent, describe


def _fmt_context(chunks: list[dict]) -> str:
    return "\n".join(f"- {c.get('text', '')[:400]}" for c in chunks) or "none"


def _timed(role: str, uid: str, message: str) -> tuple[str, float]:
    t = time.time()
    reply = call_agent(role, uid, message)
    return reply, round(time.time() - t, 1)


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

    scope = f"lecture {video_id}" if video_id else "all your lectures"
    logs.append(f"🧭 **Orchestrator:** question from `{uid}`, scope = {scope}")

    chunks = memory.recall_context(uid, query, k=4, video_id=video_id)
    logs.append(f"🔍 **Qdrant** `lecture_context` (uid filter): {len(chunks)} grounded chunk(s)")

    known = [c["concept"] for c in memory.known_concepts(uid)]
    logs.append(f"📚 **Qdrant** `knowledge_vault`: {len(known)} known concept(s) as anchors")

    message = (
        f"CONTEXT (transcript snippets):\n{_fmt_context(chunks)}\n\n"
        f"CONCEPTS THE LEARNER ALREADY KNOWS:\n{', '.join(known[:40]) or 'none'}\n\n"
        f"QUESTION: {query}\n\n"
        "Explain in max 3 short sentences. When possible, anchor new ideas to "
        "concepts from the learner's known list. No preamble."
    )
    answer, secs = _timed("tutor", uid, message)
    logs.append(f"🧠 **{describe('tutor')}:** answered in {secs}s")

    concept = _extract_term(query)
    if concept:
        level = memory.store_concept(uid, concept, answer, mastery=2)
        logs.append(f"💾 **Qdrant** `knowledge_vault`: saved '{concept}' "
                    f"(level {level}, review in {memory.REVIEW_DAYS[level]} days)")

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
def detect_gaps(uid: str, transcript_text: str, video_id: str | None = None,
                trace: list[str] | None = None) -> list[dict]:
    """Find terms this learner likely won't know and explain them before asked.

    Each returned card carries the full step trace that produced it.
    """
    trace = list(trace or [])
    known = [c["concept"] for c in memory.known_concepts(uid)]
    trace.append(f"Qdrant knowledge_vault: {len(known)} concept(s) you already know")

    gap_message = (
        f"LECTURE TRANSCRIPT:\n{transcript_text[:1500]}\n\n"
        f"TERMS THE LEARNER ALREADY KNOWS:\n{', '.join(known[:60]) or 'none'}\n\n"
        "List up to 3 technical terms/names in the transcript that the learner "
        "does NOT know (not in their list). Skip vocabulary any first-week "
        "ML student has heard — such as token, model, data, training, layer, "
        "network, function, parameter, algorithm, system, output, input, "
        "probability, matrix. Only flag terms a learner would genuinely have "
        "to pause and look up: named techniques, architectures, papers, "
        "people, libraries, specific mechanisms. "
        "Respond ONLY with a JSON array of term strings, e.g. [\"term1\", \"term2\"]."
    )
    raw, secs = _timed("gap", uid, gap_message)
    print(f"[gap-detector] raw Lyzr reply: {raw[:300]}")
    terms = _extract_json_array(raw)
    terms = [t for t in terms if isinstance(t, str) and 1 < len(t) <= 60
             and len(t.split()) <= 5]
    trace.append(f"{describe('gap')}: {len(terms)} candidate(s) in {secs}s "
                 f"→ {', '.join(terms[:3]) or 'none'}")

    cards = []
    for term in terms[:3]:
        near, score = memory.closest_known(uid, term)
        if score >= memory.KNOWN_THRESHOLD:
            trace.append(f"Qdrant vault: skipped '{term}' — you know '{near}' ({score:.2f})")
            continue
        chunks = memory.recall_context(uid, term, k=2, video_id=video_id)
        explain_message = (
            f"CONTEXT (transcript):\n{_fmt_context(chunks)}\n\n"
            f"LEARNER KNOWS:\n{', '.join(known[:40]) or 'none'}\n\n"
            f"TERM: {term}\n\n"
            "Give a 2-sentence plain explanation a course learner can use "
            "immediately. First sentence = what it is, second = why it matters here."
        )
        explanation, tsecs = _timed("tutor", uid, explain_message)
        anchor = f"anchored to {len(known)} known concept(s)" if known else "vault empty, no anchors yet"
        steps = trace + [
            f"Qdrant vault: '{term}' is new to you "
            f"(closest: {near or 'nothing'}, {score:.2f} < {memory.KNOWN_THRESHOLD})",
            f"Qdrant lecture_context: {len(chunks)} snippet(s) to ground it",
            f"{describe('tutor')}: explained in {tsecs}s, {anchor}",
        ]
        cards.append({
            "term": term,
            "explanation": explanation,
            "grounded_in": [c.get("text", "")[:160] for c in chunks],
            "trace": steps,
        })
    print(f"[gap-detector] {len(terms)} candidate term(s) -> {len(cards)} card(s) built")
    return cards


# ── Review scheduling ───────────────────────────────────────────
def review_digest(uid: str) -> list[dict]:
    """Due concepts first, then the soonest upcoming ones — feeds the review view."""
    return memory.review_queue(uid)
