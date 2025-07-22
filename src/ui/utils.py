from typing import List, Dict, Any
import requests
import streamlit as st
import pandas as pd
import time
import os
import httpx
import json
from uuid import uuid4
from copy import deepcopy



HOST = os.getenv("BFF_HOST")
PORT = os.getenv("BFF_PORT")
API_BASE = f"http://{HOST}:{PORT}"

AGENTS = [
    # "OrthodoxAI v1",
    "HR-Policies v1",
    "Retail Agent v1",
]


def _safe_get(url: str) -> Any | None:
    """GET helper that shows a Streamlit error instead of raising."""
    try:
        r = requests.get(url, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        st.error(f"Unable to reach the API ({exc}).")
        return None


def _safe_post(url: str, json: dict = None) -> Any | None:
    """POST  helper that shows a Streamlit error instead of raising."""
    try:
        r = requests.post(url=url, json=json, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        st.error(f"Unable to reach the API ({exc}).")
        return None


def _safe_delete(url: str) -> bool:
    """
    Perform DELETE and return True on HTTP 204.
    Shows an error message and returns False on failure.
    """
    try:
        r = requests.delete(url=url, timeout=5)
        r.raise_for_status()
        return r.status_code == 204
    except Exception as exc:
        st.error(f"Unable to reach the API ({exc}).")
        return False


def list_conversations(user_id: str) -> List[Dict[str, Any]]:
    """Return every conversation *header* for *user_id*."""
    url = f"{API_BASE}/users/{user_id}/conversations"
    result = _safe_get(url)
    return result if isinstance(result, list) else []


def fetch_conversation(user_id: str, conv_id: str) -> Dict[str, Any]:
    """Return a single conversation body."""
    url = f"{API_BASE}/users/{user_id}/conversations/{conv_id}"
    result = _safe_get(url)
    return result or {"messages": []}


def auth_request(username: str, password: str) -> str | None:
    """POST username/password → return {True, user_id} on success, else {False}."""
    url = f"{API_BASE}/authenticate"
    json={"username": username, "password": password}
    return _safe_post(url=url, json=json)


def creds_entered() -> None:
    """
    Callback after user inputs credentials:
    - Clears input fields
    - Updates session_state based on authentication result
    """
    user   = st.session_state.get("user", "").strip()
    passwd = st.session_state.get("passwd", "").strip()

    # clear widgets so they don't keep old values
    st.session_state["user"]   = ""
    st.session_state["passwd"] = ""
    
    user_obj = auth_request(user, passwd)
    
    if user_obj['authenticated']:
        st.session_state["authenticated"] = True
        st.session_state["login_warning"] = None
        st.session_state['user_id'] = user_obj['user_id']
    else:
        # Determine appropriate warning if login failed
        if not user:
            st.session_state["login_warning"] = "Please enter username."
        elif not passwd:
            st.session_state["login_warning"] = "Please enter password."
        else:
            st.session_state["login_warning"] = "Invalid username / password 😒"


def authenticate_user() -> bool:
    """
    Render login UI if not authenticated.
    Returns True once login succeeds, else False.
    """
    # Initialise state fields once
    st.session_state.setdefault("authenticated", False)
    st.session_state.setdefault("login_warning", None)
    
    # Already authenticated? stop rendering login UI
    if st.session_state["authenticated"]:
        return True
    
    # Display login form
    st.title("Login to Agentic Chat")
    st.text_input("Username", key="user")
    st.text_input("Password", key="passwd", type="password", on_change=creds_entered)
    
    # Transient warning message
    if st.session_state["login_warning"]:
        st.warning(st.session_state["login_warning"])
        time.sleep(3)
        st.session_state["login_warning"] = None
    
    return False


def ensure_core_session_keys() -> None:
    """Initialize mandatory session keys with defaults on first load."""
    defaults = {
        "user_id": None,
        "conversation_id": uuid4().hex,
        "title": None,
        "messages": [],
        "selected_agent": AGENTS[0],
        "authenticated": False,
        "login_warning": None,
    }
    for key, default in defaults.items():
        if key not in st.session_state:
            st.session_state.setdefault(key, default)


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
            st.session_state.conversation_id = uuid4().hex
            st.session_state.title = None
            st.session_state.messages = []
            st.rerun()
        
        # Agent selector ----------------------------------------------------
        st.selectbox(
            "Choose an agent",
            AGENTS,
            key="selected_agent",
            on_change=lambda: None,
        )
        
        st.divider()
        
        # Conversation list -------------------------------------------------
        st.header("Past conversations")
        if st.session_state.user_id:
            convs = list_conversations(st.session_state.user_id)
            
            if convs:
                for i, conv in enumerate(convs):
                    conv_id = conv.get("conversation_id")
                    label = conv.get("title")[:15] + '...' if conv.get("title") is not None else f'Conversation {i}'
                    col_conv, col_del = st.columns([0.80, 0.20])
                    with col_conv:
                        clicked = st.button(
                            label,
                            key=("conv_btn", conv_id),
                            use_container_width=True,
                        )

                    with col_del:
                        del_clicked = st.button(
                            label="",  # icon‑only button
                            key=("del_btn", conv_id),
                            icon="❌",  # Streamlit built‑in icon support
                            help="Delete conversation",
                            use_container_width=True,
                        )
                    
                    # Fetch Conversation functionality on click
                    if clicked:
                        try:
                            conv_data = fetch_conversation(st.session_state.user_id, conv_id)
                            
                            for i, msg in enumerate(conv_data.get("messages", [])):
                                if msg["role"] == "assistant" and "reasoning" in msg:
                                    if isinstance(msg["reasoning"], str):
                                        try:
                                            conv_data["messages"][i]['reasoning'] = json.loads(msg["reasoning"])
                                        except json.JSONDecodeError:
                                            conv_data["messages"][i]['reasoning'] = []
                            
                            st.session_state.conversation_id = conv_data.get("conversation_id", conv_id)
                            st.session_state.messages = conv_data.get("messages", [])
                            st.session_state.title = conv_data.get("title", '')
                            st.toast("Conversation loaded!")
                        except Exception as ex:
                            st.info(ex)
                    
                    # Delete conversation functionality on click
                    if del_clicked:
                        if st.session_state.user_id:
                            url = (
                                f"{API_BASE}/users/{st.session_state.user_id}/conversations/{conv_id}"
                            )
                            if _safe_delete(url):
                                st.success("Conversation deleted.")
                                # Remove from local list and rerun UI
                                convs.pop(i)
                                st.rerun()
                        else:
                            st.warning("No user authenticated - can't delete conversation.")
            else:
                st.info("Didn't found any past conversation for you!")
        else:
            st.info("No user to fetch the relevant conversations!")


def build_payload():
    """
    Prepare JSON payload for agent inference.
    Serializes assistant reasoning into JSON strings.
    """
    messages = deepcopy(st.session_state['messages'])
    for msg in messages:
        if msg['role'] == 'assistant' and msg['reasoning']:
                msg['reasoning'] = json.dumps(msg.get('reasoning'))
    
    payload = {
        "user_id": st.session_state['user_id'],
        "conversation_id": st.session_state["conversation_id"],
        "title": st.session_state['title'],
        "messages": messages,
        "agents": [st.session_state['selected_agent']]
    }
    return payload


def stream_agent_response(payload: Dict):
    """
    Generator that streams ('response'|'reasoning') tuples
    from the backend as lines of JSON.
    """
    agent_url = f"{API_BASE}/user/{payload['user_id']}/inference"

    try:
        with httpx.Client(timeout=None) as client:
            with client.stream("POST", url=agent_url, json=payload, timeout=None) as resp:
                resp.raise_for_status()
                
                for line in resp.iter_lines():
                    if not line.strip():
                        continue
                    
                    try:
                        chunk = json.loads(line)
                        ctype = chunk.get("type")

                        if ctype == "response":
                            content = chunk.get("content", "")
                            yield "response", content, None
                            
                        elif ctype == "reasoning":
                            node = chunk.get("node", "")
                            content = chunk.get("content", "")
                            yield "reasoning", content, node
                            
                    except json.JSONDecodeError as e:
                        st.error(f"Error parsing JSON: {e}")
                        continue
                        
    except Exception as e:
        st.error(f"Error during streaming: {e}")
