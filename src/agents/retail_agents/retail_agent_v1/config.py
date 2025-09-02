import os
import re

OPENAI_GPT_o4_MINI = "o4-mini"
OPENAI_GPT_o3_MINI = "o3-mini"
OPENAI_GPT_o1_MINI = "o1-mini"
OPENAI_GPT_4o = "gpt-4o-2024-08-06"
OPENAI_GPT_4_1_MINI = "gpt-4.1-mini-2025-04-14"
OPENAI_GPT_4_1 = "gpt-4.1-2025-04-14"

ANTHROPIC_3_7_SONNET = "claude-3-7-sonnet-latest"
ANTHROPIC_3_5_SONNET = "claude-3-5-sonnet-latest"
ANTHROPIC_3_5_HAIKU = "claude-3-5-haiku-latest"

TABLE = "Financial Sample"
TABLE = re.sub(r"\W+", "_", TABLE).strip("_").lower()

RAG_HOST = os.getenv("RAG_HOST", "rag_service")
RAG_PORT = os.getenv("RAG_PORT", "8001")

ROOT_ENDPOINT = f"http://{RAG_HOST}:{RAG_PORT}/"
SCHEMA_ENDPOINT = ROOT_ENDPOINT + f"excel/{TABLE}/schema"
QUERY_ENDPOINT = ROOT_ENDPOINT + f"excel/{TABLE}/query/sql"