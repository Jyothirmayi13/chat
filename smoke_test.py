"""smoke_test.py — verifies the full loop without external API keys."""
import os
os.environ["QDRANT_URL"] = "http://127.0.0.1:9"  # force embedded fallback

import memory
import agents

memory.init_db()
print("[1] collections ok")

memory.remember_context("learner", "Backpropagation adjusts weights using gradient descent.",
                        video_id="vid1", source="test", start_time=0, end_time=45)
memory.remember_context("learner", "Overfitting occurs when a model memorizes training data.",
                        video_id="vid1", source="test", start_time=45, end_time=90)
hits = memory.recall_context("learner", "how does training adjust weights", k=2)
assert hits, "semantic recall returned nothing"
print(f"[2] semantic recall ok -> '{hits[0]['text'][:50]}...' score-based")

memory.store_concept("learner", "gradient descent", "step-by-step downhill optimization")
assert memory.knows_semantically("learner", "gradient descent"), "known-term check failed"
assert not memory.knows_semantically("learner", "transformer attention heads"), "unknown term wrongly known"
print("[3] vault knows/unknown discrimination ok")

cards = agents.detect_gaps("learner", "We use dropout to reduce overfitting and tune the learning rate.")
print(f"[4] gap detector ran (Lyzr stub response) -> {cards}")

result = agents.run_workflow("What is overfitting?", "learner", video_id="vid1")
assert len(result["logs"]) >= 6
print(f"[5] reactive pipeline logs: {len(result['logs'])} steps")
for line in result["logs"]:
    print("    ", line)

assert memory.forget("learner", "gradient descent")
print("[6] forget (privacy) ok")
print("SMOKE TEST PASSED")
