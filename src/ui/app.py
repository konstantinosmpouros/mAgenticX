from __future__ import annotations

import uuid
import streamlit as st
from utils import list_conversations, fetch_conversation, authenticate_user


AGENTS = ["OrthodoxAI_v1"]


def ensure_core_session_keys() -> None:
    """Seed mandatory session keys once."""
    defaults = {
        "user_id": None,
        "conversation_id": None,
        "title": None,
        "messages": [],
        "selected_agent": AGENTS[0],
    }
    for key, default in defaults.items():
        if key not in st.session_state:
            st.session_state.setdefault(key, default)



def render_sidebar() -> None:
    """Left-hand sidebar with conversations & controls."""
    with st.sidebar:
        
        # New conversation button -------------------------------------------
        if st.button("New conversation", key="new_conv_btn"):
            st.session_state.conversation_id = uuid.uuid4().hex
            st.session_state.title = None
            st.session_state.messages = []

        # Agent selector ----------------------------------------------------
        st.selectbox(
            "Choose an agent",
            AGENTS,
            key="selected_agent",
            on_change=lambda: None,  # forces sync to session_state
        )

        st.divider()

        # Conversation list -------------------------------------------------
        st.header("Past conversations")
        if st.session_state.user_id:
            convs = list_conversations(st.session_state.user_id)

            if convs:
                for i, conv in enumerate(convs):
                    conv_id = conv.get("conversation_id")
                    label = conv.get("title") if conv.get("title") is not None else f'Conversation {i}'
                    clicked = st.button(label, key=("conv_btn", conv_id))
                    if clicked:
                        data = fetch_conversation(st.session_state.user_id, conv_id)
                        st.session_state.conversation_id = data.get("conversation_id", conv_id)
                        st.session_state.messages = data.get("messages", [])
                        st.session_state.title = data.get("title", None)
            else:
                st.info("Didn't found any conversation for you!")
        else:
            st.info("No user to fetch the relevant conversations!")



def render_chat() -> None:
    """Central chat panel."""
    st.title("Chat with an AI Agent" if st.session_state.title is None else st.session_state.title)

    # Display message history
    for msg in st.session_state.messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        with st.chat_message(role):
            st.markdown(content)

    # Chat input widget
    prompt = st.chat_input("Type a message and press Enter…")
    if prompt:
        st.session_state.messages.append({"role": "user", "content": prompt})
        st.rerun()
        # TODO: Call the dialogue bridge api



def main() -> None:
    st.set_page_config(page_title="Agentic Chat", page_icon="🕊️")
    ensure_core_session_keys()
    
    if not authenticate_user():
        st.stop()
    
    render_sidebar()
    render_chat()


if __name__ == "__main__":
    main()
