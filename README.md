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
| Where you end up | New tab, place lost | Card floats on the watch page itself |
| After the answer | Gone | Vault entry + spaced-repetition review |

We are not claiming to look up a word faster than Gemini. We are claiming the
other 90%: the terms you did not know to ask about, explained at the level of
what you already know, and still there next week.

## Privacy model
An always-on microphone over someone's lecture is only acceptable if the
learner holds the switch, so:
- **Off by default.** No transcript is analysed until `POST /api/coach {on:true}`.
  The web mic and the Omi webhooks both respect it; the Live Coach tab shows the state.
- **The mic stops when you leave.** Hiding the PWA tab ends capture immediately.
- **`DROP_WORDS`** discards any chunk containing a phrase you list — before it is
  embedded, stored, or sent to Lyzr.
- **Your own speech is not lecture content.** Omi's `is_user` segments are stored as
  context but never fed to the gap detector, so asking a question out loud cannot
  produce a card about your own words.
- **Forget per concept.** The vault has a ✕ on every entry (`POST /api/forget`).

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
omi_replay.py    Posts spec-exact Omi payloads (deterministic demo fallback)
```

## Setup
```bash
py -3.13 -m pip install -r requirements.txt    # Windows: use `py -3.13`, plain `python` may point at a bare install
copy .env.example .env                         # fill in Lyzr values

# Qdrant: Docker (recommended)
docker run -p 6333:6333 -v %cd%/qdrant_storage:/qdrant/storage qdrant/qdrant:latest
#   ...or skip Docker: leave QDRANT_URL unreachable and the app uses ./qdrant_data

py -3.13 -m uvicorn main:app --host 0.0.0.0 --port 8000   # serves API + PWA
ngrok http 8000                                            # public HTTPS URL for Omi
```
In Omi **Settings → Developer Settings**, enable the toggles and set:
- **Conversation Events** → `https://<tunnel>/omi/conversation?uid=YOUR_UID`
- **Real-time Transcript** → `https://<tunnel>/omi/realtime?uid=YOUR_UID&session_id=s1`

Omi rewrites `uid` with its own account id on every call, so the backend pins
inbound webhook traffic to `OMI_UID` (defaults to `DEFAULT_UID`, the identity the
PWA polls as). Set `OMI_UID` in `.env` only if you change that.

Free ngrok shows a "You are about to visit" interstitial to browsers only —
machine-to-machine webhook posts pass straight through, so test endpoints with
`curl`, not a browser tab.

Index a lecture for grounding (optional):
```bash
py -3.13 omi_replay.py            # spec-exact Omi payloads, no phone needed
py -3.13 ingest.py <youtube_video_id>
```

## Demo script (≤5 min)
1. Open the PWA on your phone (`https://<tunnel>`) and leave **Live Coach** on screen.
2. In Omi, tap the **record dot** and speak a sentence containing an unknown term —
   cards appear on the phone **while you are still talking** (real-time transcript webhook).
3. Tap **"Got it"** on a card → it enters the **Vault** at Lv 1.
4. **Ask** tab → ask about that term → expand the live **agent pipeline** logs → grounded answer.
5. **Vault** tab → known concepts + due-for-review; tap ✕ to **forget** (privacy).
6. Name the track and show the Omi → Qdrant → Lyzr → back-to-user loop on screen.
   If the tunnel drops mid-recording, `py -3.13 omi_replay.py` reproduces step 2's
   effect from the laptop.

## Verification
`py -3.13 smoke_test.py` runs the full memory + agent loop with the embedded Qdrant
fallback and no external keys (Lyzr calls return a clear stub when unset). All six
checks pass. The Omi leg is verified live from the Omi phone app with **no wearable
hardware** — both webhook types reach the backend and drive real cards.

## Submit
Public repo · deployed PWA URL · ≤5-min demo video · track named here · no committed keys.
