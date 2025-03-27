
# OrthodoxAI 🕊️

**OrthodoxAI** is an AI-powered multi-agent system designed to understand, retrieve, and contextualize knowledge from religious texts and audio content (e.g., the Bible, sermons, patristic writings). It leverages transcription, vector search, and agentic reasoning to provide meaningful responses and deep scriptural insight.



## 🧠 Agentic Workflow

OrthodoxAI is composed of specialized agents, each handling a specific task in the pipeline:

- **TranscriberAgent**: Converts religious audio to text (e.g., using Whisper).
- **CleanerAgent**: Cleans and formats transcripts or text files for embedding.
- **IndexerAgent**: Embeds and stores texts in a vector database (e.g., Qdrant, FAISS).
- **RetrieverAgent**: Retrieves contextually relevant passages based on queries.
- **ContextualizerAgent**: Adds historical and theological depth to responses.
- **DialogueAgent**: Interfaces with the user and manages the query-response flow.
- **MemoryAgent**: Stores long-term memory and learned insights.



## 🔍 Use Cases

- Semantic search across the Bible, patristic texts, and sermon transcriptions  
- Interactive Q&A with historical and theological context  
- Agentic reasoning over multi-modal content (text + audio)  
- Long-term memory for personalized religious exploration



## 📦 Project Structure

```
OrthodoxAI/
│
├── audio/                  # Raw audio sermons
├── books/                  # Religious texts (e.g., PDFs, TXT)
├── transcriptions/         # Output from Whisper or ASR models
├── embeddings/             # Vector representations
├── agents/                 # Agent logic and workflows
├── db/                     # Vector DB setup and metadata storage
├── rag_pipeline/           # Full RAG system orchestration
└── main.py                 # Entry point
```



## 🚀 Getting Started

### Install dependencies

```bash
pip install -r requirements.txt
```

### Transcribe an audio file

```bash
python agents/transcriber_agent.py --file audio/sermon1.mp3
```

### Index your data

```bash
python agents/indexer_agent.py --input transcriptions/
```

### Ask a question

```bash
python main.py
```



## 🛠️ Tech Stack

- 🧠 **LLMs**: OpenAI, Mistral, or Gemma
- 🔊 **ASR**: Whisper / OpenAI WhisperX
- 📚 **RAG**: Custom pipeline using FAISS or Qdrant
- 🤖 **Multi-Agent Framework**: LangGraph (optional)
- 🧠 **Memory**: Redis / Chroma for persistent chat memory



## 🙏 Contributions Welcome

Contributions, ideas, and theological guidance are all welcome to help OrthodoxAI grow.
