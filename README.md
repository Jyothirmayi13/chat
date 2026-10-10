# LearnLoop — Your Proactive Voice-first Learning Copilot

**Build track:** Meeting & Lecture Intelligence (Open Innovation eligible)
**Stack:** Omi (voice) · Qdrant (semantic memory) · Lyzr (multi-agent reasoning) — one connected loop.

## The problem
Watching an online course and hitting a technical term means pausing, leaving the tab,
googling, and losing your place. Browser AI helpers (like the Gemini icon) are
**reactive, page-locked, desktop-only, and forget you** the next session.

## What LearnLoop does differently
Instead of waiting to be asked, LearnLoop **listens to the lecture through Omi**, detects the
terms *you specifically* are likely not to know (because it remembers what you already know),
and explains them **before you even ask** — in plain language anchored to concepts you trust.
Everything you learn becomes a persistent, personal **knowledge vault** on your phone and
desktop (a PWA), with spaced-repetition review. Same experience on any device.

| | Gemini-in-Chrome | LearnLoop |
|---|---|---|
| Trigger | You must select + ask | Proactive, before you ask |
| Memory | None | Per-user Qdrant knowledge vault |
| Personalization | Generic definition | Anchored to concepts you already know |
| Devices | Desktop Chrome only | PWA (phone + desktop) + extension |
| Input | Text selection | Voice (Omi) + mic + text |

## Architecture (one execution loop)

```
        Omi app (voice)                         Chrome extension / PWA mic
   realtime + conversation hooks                 (works on any device)
              \                                       /
               \                                     /
                v                                   v
        ┌──────────────── FastAPI backend ────────────────┐
        |  /omi/* , /api/transcript  -> ingest to memory   |
        |                                                 |
        |  Proactive engine (background task):            |
        |   Gap-Detector agent -> Retriever -> Tutor      |
        |        |                                        |
        |  Reactive /api/query:                           |
        |   Manager -> Router -> Retriever -> Tutor ->    |
        |   Librarian (writes vault)                      |
        └───────|---------------------------|-------------┘
                v                           v
          Qdrant (384-dim)            Lyzr Agent Studio
      lecture_context +            multi-agent reasoning
      knowledge_vault              (REST chat endpoint)
                \                   /
                 v                 v
              PWA / extension: proactive cards + answers, per device
```

- **Omi** streams voice into `/omi/realtime` (while listening) and `/omi/conversation` (after).
- **Qdrant** holds two collections sharing one embedding space (`bge-small-en-v1.5`, 384-dim):
  `lecture_context` (what was said) and `knowledge_vault` (what you already know, with mastery).
- **Lyzr** runs the specialized agents. The backend does the retrieval and passes grounded
  context to Lyzr (works with local, Docker, or Qdrant Cloud, and keeps memory under your control).

## The agents
1. **Router / Manager** — classifies query as lecture-grounded vs open-world.
2. **Retriever** — semantic search over your lecture memory (Qdrant).
3. **Gap Detector** — reads fresh transcript + your known list, returns terms you likely won't know.
4. **Tutor** — generates a short explanation anchored to concepts you already trust.
5. **Librarian** — reads/writes the personal vault; enables `forget` (privacy) and review scheduling.

Every step is logged and shown live in the UI — the "observable agent workflow" the rubric rewards.

## File map
```
main.py          FastAPI: Omi webhooks, PWA API, proactive queue
agents.py        Lyzr multi-agent orchestration (reactive + proactive)
memory.py        Qdrant semantic memory: recall, vault, knows(), forget
lyzr_client.py   REST wrapper for Lyzr Studio (specialists + manager fallback)
ingest.py        YouTube transcript -> time-chunked semantic memory
config.py        Env loading, Qdrant (server or embedded fallback), models
pwa/             Cross-device frontend (index/app.js/styles/manifest/sw/icon)
extension/       Chrome extension (progressive enhancement)
smoke_test.py    End-to-end loop test, no external keys required
```

## Setup
```bash
pip install -r requirements.txt
cp .env.example .env          # fill in Lyzr + Qdrant values

# Qdrant: Docker (recommended)
docker run -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant:latest
#   ...or skip Docker: leave QDRANT_URL unreachable and the app uses ./qdrant_data

uvicorn main:app --port 8000   # serves API + PWA at http://localhost:8000
ngrok http 8000                 # public HTTPS URL for Omi webhooks
```
In Omi **Settings → Developer Mode**, set:
- Memory-creation webhook → `https://<tunnel>/omi/conversation?uid=YOUR_UID`
- Real-time transcript webhook → `https://<tunnel>/omi/realtime?uid=YOUR_UID&session_id=s1`

Index a lecture for grounding (optional):
```bash
python ingest.py <youtube_video_id>     # or POST /api/ingest_youtube
```

## Demo script (≤5 min)
1. Speak/queue a lecture clip → show transcript chunks appear in Qdrant dashboard.
2. A **proactive card pops up on the phone PWA** for a term you never asked about → tap "Got it" → it enters the vault.
3. Ask a question in the **Ask** tab → expand the live **agent pipeline** logs → grounded answer.
4. Open **Vault** → known concepts + due-for-review; tap ✕ to **forget** (privacy).
5. Name the track and show the Omi → Qdrant → Lyzr → back-to-user loop on screen.

## Verification
`python smoke_test.py` runs the full memory + agent loop with the embedded Qdrant fallback and no external keys (Lyzr calls return a clear stub when unset). All six checks pass.

## Submit
Public repo · deployed PWA URL · ≤5-min demo video · track named here · no committed keys.
