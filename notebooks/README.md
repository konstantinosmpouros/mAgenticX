# Notebooks

## Overview
This directory hosts exploratory Jupyter notebooks that inform the production services. They cover agent workflow experiments, retrieval evaluations, speech-to-text analysis, and tooling prototypes. Outputs here are not packaged for deployment but provide the reference implementations that shaped the `agents`, `rag_service`, and `dialogue_bridge` codebases.

## How It Fits
Notebook experiments act as a proving ground for ideas that later move into the core services. Treat this area as a sandbox for research, benchmarking, and documentation of investigative work.

## Contents
- `Agents.ipynb` - experiments with LangGraph orchestration, prompt templates, and tool routing for the OrthodoxAI, HR, and Retail agents.
- `RAG.ipynb` - retrieval evaluations, collection curation, and sanity checks for the Chroma-backed knowledge base.
- `STT_Analysis.ipynb` - comparisons of transcription providers (OpenAI Whisper, ElevenLabs, etc.) plus audio preparation utilities.
- `Tools.ipynb` - prototyping of utility functions later wrapped as LangChain tools (financial data, search APIs, document processing).
- `knowledge_base/` - curated data sources used when building RAG collections (HR policy revisions, Orthodox resources, etc.).
- `vectorstore/` - scratch space for local Chroma indexes generated during notebook runs.
- `logs/` - captured metrics and intermediate JSON dumps from experiments.
- `utils.py` - helper functions shared across notebooks (audio discovery, duration calculation, theme extraction).

## Getting Started
Create an isolated environment and install the dependencies you need for the notebook you plan to run. A minimal setup looks like:

```shell
cd notebooks
python -m venv .venv
.\.venv\Scripts\activate    # use source .venv/bin/activate on POSIX
pip install jupyterlab pandas duckdb openpyxl chromadb langchain-openai pydub mutagen
jupyter lab
```

Set `OPENAI_API_KEY` (and any other provider keys) in your shell before running notebooks that call external APIs.

## Usage Notes
- Notebooks may write temporary files into `logs/` or `vectorstore/`; clear these directories if you want a clean slate.
- Keep large datasets out of version control. Store source documents under `knowledge_base/` and reference them from the notebooks.
- When an experiment yields production-ready logic, port the code into the appropriate service (`src/agents`, `src/rag_service`, etc.) and keep the notebook as documentation.
