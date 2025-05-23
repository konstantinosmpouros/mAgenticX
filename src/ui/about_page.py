# about_page.py
import streamlit as st

st.title("About OrthodoxAI 🕊️")
st.markdown(
    """
**OrthodoxAI** is a multi-agent system that understands, retrieves and contextualises
Biblical passages, patristic writings and transcribed sermons.

### 🔍 What can it do?
- **Semantic search** across scripture, Church Fathers and homiletic audio  
- **Interactive Q&A** with historical & theological context in plain language  
- **Multi-modal reasoning**: text + audio, fused through a custom RAG pipeline  
- **Long-term memory** of your prior discussions for ever-deeper dialogue  

### 🛠️ How is it built?
| Layer | Tech / Library | Purpose |
|-------|----------------|---------|
| Agents | **LangGraph** | Orchestrates specialised reasoning agents |
| Retrieval | **FAISS / Qdrant** | Fast vector search over indexed texts |
| Memory | **Redis / Chroma** | Persistent chat + doc embeddings |
| LLMs | **OpenAI family** | Core language understanding |
| ASR | **Whisper** | Transcribes sermons & lectures |

*(Full repo layout: `src/orthodox_agents/`, `src/rag_service/`, `src/vectorstores/`, `src/ui/` etc.)* :contentReference[oaicite:0]{index=0}

### 🙏 Contribute
The project welcomes theological insights, code PRs and feedback.  Help us grow
OrthodoxAI into a valuable tool for deep religious exploration.
"""
)
