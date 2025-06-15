from pydantic import BaseModel, Field

class Query(BaseModel):
    query: str
    k: int = 10

