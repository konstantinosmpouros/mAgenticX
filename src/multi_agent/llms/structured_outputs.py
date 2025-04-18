from pydantic import BaseModel, Field
from typing import Literal, List, Optional


class AnalyzerOutput(BaseModel):
    is_religious: Literal["Religious", "Non-Religious"] = Field(
        ...,
        description="True if the query relates explicitly to religious or theological matters of orthodox christianity, otherwise, False.",
    )
    clarification_needed: bool = Field(
        ...,
        description="True if further clarification from the user is needed; otherwise, False.",
    )
    clarification_instructions: Optional[str] = Field(
        None,
        description="Specific instructions on what clarification is required from the user, if applicable.",
    )
    key_topics: List[str] = Field(
        ...,
        description="List of key topics/areas related to the user's question (e.g., theology, jesus, humility, virtues)",
    )
    context_requirements: str = Field(
        ..., description="A clear explanation of the query's context needs"
    )
    query_complexity: Literal["Low", "Medium", "High"] = Field(
        ..., description="'Low', 'Medium', or 'High' complexity"
    )
    reasoning: str = Field(
        ...,
        description="The Chain of Thought that has been done in order to analyze the user query",
    )


class RetrievalQueriesOutput(BaseModel):
    queries: List[str] = Field(
        ...,
        description="A list of concise and semantically meaningful queries derived from the user's original input, intended for searching in a vector database.",
    )


class ReflectionOutput(BaseModel):
    requires_additional_retrieval: bool = Field(
        ...,
        description="True if additional context or data retrieval is needed to fully address the user's query.",
    )
    reflection: Optional[str] = Field(
        None,
        description="""Robust and meaningful critique provided only if 'requires_additional_retrieval' is True.
            This should thoroughly evaluate the answer's accuracy, theological consistency, coherence, 
            and completeness. Clearly outline specific deficiencies, contradictions, 
            or missing critical information that necessitates additional retrieval.
        """
    )
    recommended_next_steps: Optional[str] = Field(
        None,
        description="Clear and actionable recommendations detailing precisely what additional retrieval or clarifications are required, provided only if 'requires_additional_retrieval' is True.",
    )
