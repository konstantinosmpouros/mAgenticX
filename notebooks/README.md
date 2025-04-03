
# 🧪 OrthodoxAI Notebooks

This directory contains a collection of exploratory Jupyter notebooks used to prototype and validate core components of the OrthodoxAI multi-agent system.

These notebooks serve as an experimental space to test ideas, evaluate models, and build workflows before integrating them into the main production codebase.



## 💡 Purpose

The `notebooks/` folder allows for rapid iteration and concept development, including:

- Evaluating transcription quality from various STT model providers(e.g., ElevenLabs, OpenAI)
- Testing embedding models and vector store indexing
- Experimenting with prompt engineering and agent behaviors
- Prototyping RAG pipelines and memory management
- Visualizing graph workflows and retrieval results



## 📓 Notebook Index

| Notebook            | Description |
|---------------------|-------------|
| `Agents.ipynb`      | Prototypes agent behaviors, workflows, and communication patterns within the OrthodoxAI system. Used to simulate agent interaction and decision-making before building out the full LangGraph-based flow. |
| `STT_Analysis.ipynb`| Evaluates and compares speech-to-text (STT) performance using models like Whisper. Includes analysis of transcript quality and preprocessing techniques. |
| `Tools.ipynb`       | Tests and develops helper tools and utilities such as file converters, audio preprocessors, or format normalizers. Supports building reusable components for the main pipeline. |




## 🛠️ Running the Notebooks

Install Jupyter and dependencies if you haven’t already:

```bash
pip install jupyterlab
```

Then launch the notebook interface:

```bash
jupyter lab
```



## 📌 Disclaimer

These notebooks are **work-in-progress** tools for research and development. Final, production-ready versions of the logic are integrated into the main pipeline (`OrthodoxAI/src`).

