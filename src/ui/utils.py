from typing import List, Dict, Any
import requests
import streamlit as st
import os


HOST = os.getenv("BFF_HOST")
PORT = os.getenv("BFF_PORT")
API_BASE = f"http://{HOST}:{PORT}"

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
    """GET helper that shows a Streamlit error instead of raising."""
    try:
        r = requests.post(url=url, json=json, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        st.error(f"Unable to reach the API ({exc}).")
        return None


def list_conversations(user_id: str) -> List[Dict[str, Any]]:
    """Return every conversation *header* for *user_id*."""
    url = f"{API_BASE}/users/{user_id}/conversations/"
    result = _safe_get(url)
    return result if isinstance(result, list) else []


def fetch_conversation(user_id: str, conv_id: str) -> Dict[str, Any]:
    """Return a single conversation body."""
    url = f"{API_BASE}/users/{user_id}/conversations/{conv_id}"
    result = _safe_get(url)
    return result or {"messages": []}


def auth_request(username: str, password: str) -> str | None:
    """POST username/password → return user_id on success, else *None*."""
    url = f"{API_BASE}/authenticate"
    json={"username": username, "password": password}
    results = _safe_post(url=url, json=json)
    return results
    



