import streamlit as st
from utils import *
import pandas as pd

# Set page config
st.set_page_config(page_title="Agentic Chat", page_icon="🕊️")

# Ensure core session keys
ensure_core_session_keys()

# Authenticate user and then proceed
if not authenticate_user():
    st.stop()

# Display the sidebar
render_sidebar()

title = st.session_state['title'] if st.session_state['title'] is not None else "Chat with AI Agents"
st.title(title)

# Display chat history
for message in st.session_state["messages"]:
    with st.chat_message(message["role"]):
        if "reasoning" in message and message["reasoning"]:
            with st.expander("Reasoning"):
                for thought in message["reasoning"]:
                    bullet = thought['chunks']
                    node = thought['node'].upper()
                    st.markdown(f"- {bullet} \n\n")
        if "content" in message and message["content"]:
            st.write(message["content"])


# User input
user_input = st.chat_input("Type your message here...")

if user_input:
    # Append user message to session state
    st.session_state["messages"].append({"role": "user", "content": user_input})
    
    with st.chat_message("user"):
        st.markdown(user_input)
    
    # Construct payload
    payload = build_payload()
    
    # Stream and display assistant response
    with st.chat_message("assistant"):
        reasoning_container = st.expander("Reasoning", expanded=True)
        response_container = st.empty()
        
        # Initialize accumulators
        accumulated_response = ""
        reasoning_cells = []
        current_node = None
        
        for chunk_type, content, node in stream_agent_response(payload):
            if chunk_type == "reasoning":
                # Handle reasoning accumulation
                reasoning_cells.append({"node": node, "chunks": content})
                current_node = node
                with reasoning_container:
                    st.markdown(f"- {content} \n\n")
            elif chunk_type == "response":
                accumulated_response += content
                response_container.write(accumulated_response)
            
    # Append complete assistant message to session state
    st.session_state["messages"].append({
        "role": "assistant",
        "content": accumulated_response,
        "reasoning": reasoning_cells,
    })
    st.rerun()


