# history_page.py
import streamlit as st


if "messages" not in st.session_state:
    st.session_state["messages"] = [] 
if "selected_agent" not in st.session_state:
    st.session_state["selected_agent"] = "Orthodox_v1"


def get_conversations(user_id: str) -> list[list[dict]]:
    """
    Replace with real store call.
    Each conversation is a list of {'role': str, 'content': str} dictionaries.
    """
    # --- stub demo: three tiny convos ---------------------------------------
    return [
        [
            {"role": "user", "content": "Hello!"},
            {"role": "assistant", "content": "Hi there 👋"},
        ],
        [
            {"role": "user", "content": "Tell me about Psalm 23."},
            {"role": "assistant", "content": "Psalm 23 begins 'The Lord is my shepherd…'"},
        ],
        [
            {"role": "user", "content": "Who was St. Basil?"},
            {"role": "assistant", "content": "St. Basil the Great was…"},
        ],
    ]


st.subheader("📜 Conversation History")

conversations = get_conversations(user_id="anonymous")

if not conversations:
    st.info("No past conversations available.")
else:
    # Display each past convo as a button/card
    for idx, convo in enumerate(conversations):
        # Create a label for the conversation (e.g., use first user message as preview)
        if convo:
            first_user_msg = next((m["content"] for m in convo if m["role"]=="user"), "")
        else:
            first_user_msg = ""
        preview = (first_user_msg[:50] + "...") if len(first_user_msg) > 50 else first_user_msg
        label = f"💬 Conversation {idx+1}: {preview}" if preview else f"💬 Conversation {idx+1}"
        # Show as a full-width button (looks like a card/list item)
        if st.button(label, key=f"conv{idx}", use_container_width=True):
            # Load this conversation into the active chat
            st.session_state.messages = convo.copy()
            st.switch_page("chat_page.py")
