# mAgenticX (UNDERDEVELOPMENT)

**mAgenticX** is an AI-powered multi-agent system designed to understand, retrieve,
and contextualize knowledge from texts, image and audio content. Its a chat interface that the user can select
from an agent pool, one to chat with and solve a specified problem.
It leverages transcription, vector search, and agentic reasoning to provide meaningful,
context-rich responses and deep insight.

## Key capabilities

- **Multi-modal understanding**  
  Works with text, images, and audio. Uses transcription for audio, and retrieval for long or multi-file contexts.

- **Agent pool with tool use**  
  Define multiple specialists (e.g., Researcher, Data Explorer, Summarizer). Each agent can call tools (RAG, web, parsing, etc.) and hand off tasks.

- **Retrieval-Augmented Generation (RAG)**  
  Ingestion + chunking + embeddings + vector search to ground replies in your own knowledge sources.

- **Composable services**  
  Clean separation between UI, dialogue/agent orchestration, RAG, and vector store backends so you can swap or scale components independently.

- **Container-first**  
  Everything runs via Docker Compose. Local development is prioritized; cloud deployment patterns can be added later.


## 📦 Project Structure (Overview)

The project follows a modular design with the following major components:

- **docs/**: Documentation and workflow visuals  
- **notebooks/**: Exploratory analysis and prototyping  
- **src/agents/**: Core implementation of agents, workflows and tools
- **src/rag_service/**: A service specialized to retrieve relevant documents to a query form the vector store
- **src/vectorstores/**: The vector stores as a db service
- **src/agentic_ui/**: Frontend or user interface layer
- **src/dialogue_bridge/**: Inner layer between the UI and agents that handle the chat history, messages, attachments and everything else.


## 🛠️ Tech Stack

- 🧠 **LLMs**: OpenAI
- 🔊 **ASR**: Whisper
- 📚 **RAG**: Custom retrieval pipeline
- 🤖 **Agent Framework**: LangGraph
- 🧠 **Memory**: Chroma for persistent long-term storage  
- 🌅 **UI**: React, Typescript, Tailwind CSS

## 🙏 Contributions Welcome

We welcome theological insights, code contributions, 
and feedback to help OrthodoxAI grow into a valuable tool for deep religious exploration.
