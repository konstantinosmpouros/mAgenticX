from pydantic import BaseModel, Field
from typing import Literal, Optional


class AnalysisOutput(BaseModel):
    intent: Literal["schema_help", "data", "other"] = Field(
        ..., description="Exactly one of: schema_help, data, other"
    )
    reasoning: str = Field(
        ..., description="Brief rationale (1-2 sentences max)."
    )
    user_language: str = Field(
        None,
        description="""
            The user's language used in the original query,
            which should be used to explain the schema.
        """
    )
    sql_description: Optional[str] = Field(
        None,
        description="""
            Only when intent is "data". 
            A concise description of the SQL query to be generated, 
            explaining what it will compute or retrieve according to the user input.
        """
    )

class SQLQueryOutput(BaseModel):
    sql_query: str = Field(..., description="The generated SQL query.")



