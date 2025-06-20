import os

OPENAI_REASONING_LLM_1 = "o4-mini"
OPENAI_REASONING_LLM_2 = "o3-mini"
OPENAI_REASONING_LLM_3 = "o1-mini"
OPENAI_LLM_1 = "gpt-4o-2024-08-06"
OPENAI_LLM_2 = "gpt-4.1-mini-2025-04-14"
OPENAI_LLM_3 = "gpt-4.1-2025-04-14"

ANTHROPIC_REASONING_LLM_1 = "claude-3-7-sonnet-latest"
ANTHROPIC_LLM_1 = "claude-3-5-sonnet-latest"
ANTHROPIC_LLM_2 = "claude-3-5-haiku-latest"

_RAG_HOST = os.getenv("RAG_HOST", "rag_service")
_RAG_PORT = os.getenv("RAG_PORT", "8001")
    
_COLLECTION_NAME = "hr_policies"
ENDPOINT = f"http://{_RAG_HOST}:{_RAG_PORT}/retrieve/{_COLLECTION_NAME}"