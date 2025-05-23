import streamlit as st

def show_login():
    """Display login form and handle authentication"""
    st.title("Login to OrthodoxAI 🕊️")
    
    with st.form("login_form"):
        username = st.text_input("Username")
        password = st.text_input("Password", type="password")
        submit = st.form_submit_button("Login")
        
        if submit:
            if username == "admin" and password == "040298140a":
                st.session_state.authenticated = True
                st.session_state.username = username
                st.rerun()
            else:
                st.error("Invalid username or password")

def show_logout():
    """Display logout button in sidebar"""
    with st.sidebar:
        st.write(f"👤 Logged in as: {st.session_state.get('username', 'Unknown')}")
        if st.button("🚪 Logout"):
            # Clear authentication state
            st.session_state.authenticated = False
            if 'username' in st.session_state:
                del st.session_state.username
            st.rerun()