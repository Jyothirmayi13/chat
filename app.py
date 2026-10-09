"""
app.py — Streamlit UI for the Personal Knowledge Vault.
"""

import streamlit as st
from agents import run_workflow

# ── Page Config ──────────────────────────────────────────────────
st.set_page_config(page_title="Personal Knowledge Vault", page_icon="🧠")
st.title("🧠 Personal Knowledge Vault")

# ── Sidebar: Observability Dashboard ─────────────────────────────
with st.sidebar:
    st.header("🔍 Agent Observability Dashboard")
    st.markdown(
        "**Pipeline:**\n"
        "1. 👂 Listener → 2. 🔍 Retriever → "
        "3. 🧠 Tutor → 4. 📚 Librarian"
    )
    st.divider()
    status_box = st.empty()
    status_box.info("⏳ Live Agent Status: Waiting for input...")

# ── Main Column: Input Fields ────────────────────────────────────
user_query = st.text_input(
    "🎙️ Simulate Omi Voice Input",
    placeholder="e.g., What is backpropagation?",
)
timestamp = st.text_input(
    "⏱️ Video Timestamp",
    placeholder="e.g., 00:30",
)

# ── Workflow Execution ───────────────────────────────────────────
if st.button("🚀 Run Agent Workflow", type="primary"):
    if not user_query or not timestamp:
        st.warning("Please fill in both fields.")
    else:
        status_box.success("🟢 Agents are running...")
        st.write_stream(run_workflow(user_query, timestamp))
        status_box.success("✅ Workflow complete!")
