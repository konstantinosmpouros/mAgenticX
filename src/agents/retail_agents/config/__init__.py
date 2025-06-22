import os
import re

OPENAI_REASONING_LLM_1 = "o4-mini"
OPENAI_REASONING_LLM_2 = "o3-mini"
OPENAI_REASONING_LLM_3 = "o1-mini"
OPENAI_LLM_1 = "gpt-4o-2024-08-06"
OPENAI_LLM_2 = "gpt-4.1-mini-2025-04-14"
OPENAI_LLM_3 = "gpt-4.1-2025-04-14"

ANTHROPIC_REASONING_LLM_1 = "claude-3-7-sonnet-latest"
ANTHROPIC_LLM_1 = "claude-3-5-sonnet-latest"
ANTHROPIC_LLM_2 = "claude-3-5-haiku-latest"

TABLE = "Financial Sample"
TABLE = re.sub(r"\W+", "_", TABLE).strip("_").lower()

RAG_HOST = os.getenv("RAG_HOST", "rag_service")
RAG_PORT = os.getenv("RAG_PORT", "8001")

ROOT_ENDPOINT = f"http://{RAG_HOST}:{RAG_PORT}/"
SCHEMA_ENDPOINT = ROOT_ENDPOINT + f"excel/{TABLE}/schema"
QUERY_ENDPOINT = ROOT_ENDPOINT + f"/excel/{TABLE}/query/sql"