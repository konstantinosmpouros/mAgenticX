# chat_page.py
import streamlit as st


st.header("💬 Chat with the Assistant")

# Layout: clear history button and agent selector side by side
controls = st.columns([1, 3])  # adjust column ratios for layout
with controls[0]:
    if st.button(" New Chat"):
        # Clear the current conversation
        st.session_state.messages = []
with controls[1]:
    st.selectbox(
        "Agent:", 
        ["Orthodox_v1",], 
        key="selected_agent"
    )


for msg in st.session_state.get("messages", []):
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])


if user_query := st.chat_input("Type your message here..."):
    # 1. Append the user message to history and display it immediately
    st.session_state.messages.append({"role": "user", "content": user_query})
    with st.chat_message("user"):
        st.markdown(user_query)

    # 2. Generate assistant response with streaming
    assistant_reply = ""  # will build this string incrementally
    with st.chat_message("assistant"):
        # Placeholder for the streaming text
        stream_area = st.empty()
        for chunk in generate_response_stream(user_query, st.session_state["selected_agent"]):
            assistant_reply += chunk
            stream_area.markdown(assistant_reply + "▌")
        stream_area.markdown(assistant_reply)  # final assistant answer

        # 3. Optionally, show reasoning steps in an expander below the answer
        reasoning_text = get_reasoning_steps(...)  # your function or logic
        if reasoning_text:
            with st.expander("🤖 Reasoning", expanded=False):
                st.write(reasoning_text)

    # 4. Append assistant response to history
    st.session_state.messages.append({"role": "assistant", "content": assistant_reply})
