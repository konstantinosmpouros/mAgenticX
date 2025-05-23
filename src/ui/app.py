import streamlit as st
from login import show_login, show_logout

# Initialize session state
if "authenticated" not in st.session_state:
    st.session_state.authenticated = False
if "user_id" not in st.session_state:
    st.session_state["user_id"] = "anonymous"
if "messages" not in st.session_state:
    st.session_state["messages"] = [] 
if "selected_agent" not in st.session_state:
    st.session_state["selected_agent"] = "Orthodox_v1"

# Set page config
st.set_page_config(page_title="OrthodoxAI Chat", page_icon="🕊️", ) # TODO: Add menu items

# Check authentication
if not st.session_state.authenticated:
    show_login()
else:
    # Show logout option in sidebar
    show_logout()
    
    # Set up the navigation menu with the pages
    pg = st.navigation([
        st.Page("chat_page.py", title="Chat", icon=":material/chat:"),
        st.Page("history_page.py", title="History", icon=":material/history:"),
        st.Page("about_page.py", title="About", icon=":material/info:")
    ])
    
    # Run the selected page
    pg.run()