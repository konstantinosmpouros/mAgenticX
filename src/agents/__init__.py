from typing import List, Literal

from pydantic import BaseModel, Field
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate

def Analyzer_Agent():
    # Initialize the structured output for the Analyzer Agent
    class AnalyzerOutput(BaseModel):
        classification: Literal["Religious", "Non-Religious"] = Field(..., description="Either 'Religious' or 'Non-Religious'")
        key_topics: List[str] = Field(..., description="List of key topics/areas related to the user's question (e.g., theology, jesus, humility, virtues)")
        context_requirements: str = Field(..., description="A clear explanation of the query's context needs")
        query_complexity: Literal["Low", "Medium", "High"] = Field(..., description="'Low', 'Medium', or 'High' complexity")

    def __init__(self):
        # Initialize OpenAI model with structured output
        structured_llm = ChatOpenAI(model='o3-mini', temperature=0).with_structured_output(AnalyzerOutput)

        # Initialize the Chat Template
        analyzer_prompt = ChatPromptTemplate.from_messages(
            [
                ("system", "You are an AI assistant that classifies user queries as either religious or non-religious and extracts key topics."),
                ("human", "Classify the following query and extract key concepts:\n\nQuery: {query}")
            ]
        )

        # Wrap the structured llm with the chat template
        self.analyzer_agent = analyzer_prompt | structured_llm