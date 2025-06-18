from pydantic import BaseModel, Field
from typing import Literal, List, Optional


class AnalyzerOutput(BaseModel):
    query_domain: Literal["HR-Policy", "General"] = Field(
        ...,
        description="'HR-Policy' if the query concerns employment law, company policy, compliance, benefits, etc.; otherwise ‘General’.",
    )
    key_topics: List[str] = Field(
        ...,
        description="Key HR or workplace topics (e.g., paid time off, performance management, grievance).",
    )
    context_requirements: str = Field(
        ..., description="What additional context is required to answer the question well."
    )
    query_complexity: Literal["Low", "Medium", "High"] = Field(
        ..., description="Overall reasoning / policy complexity.",
    )
    user_language: str = Field(
        ...,
        description="The language that user's last message was",
    )


class RetrievalQueriesOutput(BaseModel):
    queries: List[str] = Field(
        ...,
        description="A list of concise and semantically meaningful queries derived from the user's original input, intended for searching in a vector database.",
    )


class ReflectionOutput(BaseModel):
    requires_additional_retrieval: bool = Field(
        ...,
        description="True if we still need more policy or legal context to answer completely.",
    )
    reflection: Optional[str] = Field(
        None,
        description="""
            Provide only when additional retrieval is needed. 
            Critique accuracy, compliance risk, completeness, or any gaps 
            relevant to HR policy and employment law.
        """
    )
    recommended_next_steps: Optional[str] = Field(
        None,
        description="Concrete retrieval / clarification steps, only when more data is needed.",
    )

