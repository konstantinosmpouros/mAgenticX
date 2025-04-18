# OrthodoxAI 🕊️

**OrthodoxAI** is an AI-powered multi-agent system designed to understand, retrieve,
and contextualize knowledge from religious texts and audio content such as the Bible, sermons, and patristic writings.
It leverages transcription, vector search, and agentic reasoning to provide meaningful, 
context-rich responses and deep scriptural insight.



## 🧠 Agentic Workflow

OrthodoxAI utilizes a modular multi-agent architecture.
Each agent is specialized in handling a specific task within the reasoning pipeline.
Below is a high-level overview of the agent workflow:

<img alt="OrthodoxAI Workflow" height="432" src="docs/OrthodoxAI%20Workflow.png" width="768"/>

### Key Agents

- **Analyzer Agent**: Interprets user intent and routes the query appropriately.
- **Retrieval Agent**: Fetches contextually relevant information from knowledge base.
- **Summarizer Agent**: Condenses lengthy content into concise, interpretable formats.
- **Generator Agent**: Produces responses based on contextualized knowledge.
- **Reflection Agent**: Reviews and improves generated responses based on higher-order reasoning.

Each agent operates within a broader framework, using LLMs, memory modules, prompt templates,
structured outputs and specialized tools to reason over religious content.



## 🔍 Use Cases

- Semantic search across the Bible, patristic texts, and sermon transcriptions  
- Interactive Q&A with historical and theological context  
- Multi-modal understanding combining text and audio sources  
- Long-term memory for personalized theological dialogue  



## 📦 Project Structure (Overview)

The project follows a modular design with the following major components:

- **docs/**: Documentation and workflow visuals  
- **notebooks/**: Exploratory analysis and prototyping  
- **src/multi_agent/**: Core implementation of agents, workflows, RAG, memory, and tools  
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
