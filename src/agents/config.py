import os
import re

# RAG configuration
RAG_HOST = os.getenv("RAG_HOST", "rag_service")
RAG_PORT = os.getenv("RAG_PORT", "8001")
ROOT_ENDPOINT = f"http://{RAG_HOST}:{RAG_PORT}/"

# Orthodox agent configuration
ORTHODOX_COLLECTION_NAME = "athanasios-muthlinaios"
ORTHODOX_ENDPOINT = ROOT_ENDPOINT + f"retrieve/{ORTHODOX_COLLECTION_NAME}"

# Retail agent configuration
TABLE = "Financial Sample"
TABLE = re.sub(r"\W+", "_", TABLE).strip("_").lower()
SCHEMA_ENDPOINT = ROOT_ENDPOINT + f"excel/{TABLE}/schema"
QUERY_ENDPOINT = ROOT_ENDPOINT + f"excel/{TABLE}/query/sql"

# HR agent configuration
HR_COLLECTION_NAME = "hr_policies_v4"
HR_ENDPOINT = ROOT_ENDPOINT + f"retrieve/{HR_COLLECTION_NAME}"
