from __future__ import annotations

import time
import uuid
import streamlit as st
from utils import list_conversations, fetch_conversation, auth_request


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



@st.cache_data(show_spinner=False)
def get_conversations(user_id: str):
    """Return the user’s past conversations, cached."""
    return list_conversations(user_id)

def render_sidebar() -> None:
    """Left-hand sidebar with conversations & controls."""
    with st.sidebar:
        
        # New conversation button -------------------------------------------
        new_conv_clicked = st.button(
            "New chat",
            key="new_conv_btn",
            # type="primary",  # vibrant Streamlit primary style
            use_container_width=True,  # full‑width edge‑to‑edge
            help="Clear chat and begin a fresh dialogue",
        )
        if new_conv_clicked:
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
            convs = get_conversations(st.session_state.user_id)

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
                st.info("Didn't found any past conversation for you!")
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



def creds_entered():
    user   = st.session_state.get("user", "").strip()
    st.session_state["user"] = ""
    
    passwd = st.session_state.get("passwd", "").strip()
    st.session_state["passwd"] = ""
    
    user_obj = auth_request(user, passwd)
    
    if user_obj['authenticated']:
        st.session_state["authenticated"] = True
        st.session_state["login_warning"] = None
        st.session_state['user_id'] = user_obj['user_id']
    else:
        if not user:
            st.session_state["login_warning"] = "Please enter username."
        elif not passwd:
            st.session_state["login_warning"] = "Please enter password."
        else:
            st.session_state["login_warning"] = "Invalid username / password 😒"

def authenticate_user():
    # -------- initialise state fields once -------- 
    st.session_state.setdefault("authenticated", False)
    st.session_state.setdefault("login_warning", None)
    
    # -------- already authenticated? stop rendering login UI -------- 
    if st.session_state["authenticated"]:
        return True

    # -------- login UI -------- 
    st.title("Login to Agentic Chat")
    st.text_input("Username", key="user")
    st.text_input("Password", key="passwd", type="password", on_change=creds_entered)

    # -------- transient warning message -------- 
    if st.session_state["login_warning"]:
        st.warning(st.session_state["login_warning"])
        time.sleep(3)
        st.session_state["login_warning"] = None

    return False


def main() -> None:
    st.set_page_config(
        page_title="Agentic Chat",
        page_icon="🕊️",
    )
    ensure_core_session_keys()
    
    if not authenticate_user():
        st.stop()
    
    render_sidebar()
    render_chat()


if __name__ == "__main__":
    main()
