import os

OPENAI_GPT_o4_MINI = "o4-mini"
OPENAI_GPT_o3_MINI = "o3-mini"
OPENAI_GPT_o1_MINI = "o1-mini"
OPENAI_GPT_4o = "gpt-4o-2024-08-06"
OPENAI_GPT_4_1_MINI = "gpt-4.1-mini-2025-04-14"
OPENAI_GPT_4_1 = "gpt-4.1-2025-04-14"

ANTHROPIC_3_7_SONNET = "claude-3-7-sonnet-latest"
ANTHROPIC_3_5_SONNET = "claude-3-5-sonnet-latest"
ANTHROPIC_3_5_HAIKU = "claude-3-5-haiku-latest"

_RAG_HOST = os.getenv("RAG_HOST", "rag_service")
_RAG_PORT = os.getenv("RAG_PORT", "8001")

_COLLECTION_NAME = "hr_policies_v4"
ENDPOINT = f"http://{_RAG_HOST}:{_RAG_PORT}/retrieve/{_COLLECTION_NAME}"