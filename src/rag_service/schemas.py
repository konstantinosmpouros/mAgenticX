from pydantic import BaseModel, Field

class Query(BaseModel):
    """Model for a simple text query to retrieve from a vector store."""
    query: str
    k: int = 10

class ExcelSQLQuery(BaseModel):
    """Model for SQL queries to be executed on Excel files."""
    sql: str

