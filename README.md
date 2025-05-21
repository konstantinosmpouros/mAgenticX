# OrthodoxAI 🕊️

**OrthodoxAI** is an AI-powered multi-agent system designed to understand, retrieve,
and contextualize knowledge from religious texts and audio content such as the Bible, sermons, and patristic writings.
It leverages transcription, vector search, and agentic reasoning to provide meaningful, 
context-rich responses and deep scriptural insight.

## 🔍 Use Cases

- Semantic search across the Bible, patristic texts, and sermon transcriptions  
- Interactive Q&A with historical and theological context  
- Multi-modal understanding combining text and audio sources  
- Long-term memory for personalized theological dialogue  

## 📦 Project Structure (Overview)

The project follows a modular design with the following major components:

- **docs/**: Documentation and workflow visuals  
- **notebooks/**: Exploratory analysis and prototyping  
- **src/orthodox_agents/**: Core implementation of agents, workflows and tools
- **src/rag_service/**: A service specialized to retrieve relevant documents to a query form the vector store
- **src/vectorstores/**: The vector stores as a db service
- **src/ui/**: Frontend or user interface layer  

## 🛠️ Tech Stack

- 🧠 **LLMs**: OpenAI
- 🔊 **ASR**: Whisper
- 📚 **RAG**: Custom retrieval pipeline using FAISS or Qdrant  
- 🤖 **Multi-Agent Framework**: LangGraph 
- 🧠 **Memory**: Redis / Chroma for persistent long-term storage  

## 🙏 Contributions Welcome

We welcome theological insights, code contributions, 
and feedback to help OrthodoxAI grow into a valuable tool for deep religious exploration.
