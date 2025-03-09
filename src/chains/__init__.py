from typing import List, Literal

from pydantic import BaseModel, Field
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate


def analyzer_chain():
    # Initialize the structured output for the Analyzer Agent
    class AnalyzerOutput(BaseModel):
        classification: Literal["Religious", "Non-Religious"] = Field(..., description="Either 'Religious' or 'Non-Religious'")
        key_topics: List[str] = Field(..., description="List of key topics/areas related to the user's question (e.g., theology, jesus, humility, virtues)",)
        context_requirements: str = Field(..., description="A clear explanation of the query's context needs")
        query_complexity: Literal["Low", "Medium", "High"] = Field(..., description="'Low', 'Medium', or 'High' complexity")

    # Initialize OpenAI model with structured output
    structured_llm = ChatOpenAI(model="o3-mini", temperature=0).with_structured_output(AnalyzerOutput)

    # Initialize the Chat Template
    analyzer_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are an AI assistant that classifies user queries as either religious or non-religious and extracts key topics.",
            ),
            (
                "human",
                "Classify the following query and extract key concepts:\n\nQuery: {query}",
            ),
        ]
    )

    # Wrap the structured llm with the chat template
    chain = analyzer_prompt | structured_llm
    return chain


def summarizer_chain():
    # Initialize the structured output for the Summarizer Agent
    class SummarizerOutput(BaseModel):
        summary: str = Field(..., description="")

    # Initialize OpenAI model with structured output
    structured_llm = ChatOpenAI(model="o3-mini", temperature=0).with_structured_output(SummarizerOutput)

    # Initialize the Chat Template for summarization
    summarizer_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are an AI assistant that summarizes the retrieved chunks in a concise and coherent manner, providing a clear description of what was retrieved.",
            ),
            (
                "human",
                "Please provide a brief summary of the following retrieved chunks:\n\nText: {text}",
            ),
        ]
    )

    # Wrap the structured LLM with the chat template
    chain = summarizer_prompt | structured_llm
    return chain
