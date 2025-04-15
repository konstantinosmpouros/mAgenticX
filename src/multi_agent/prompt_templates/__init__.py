from langchain.prompts import ChatPromptTemplate
from .system import (
    ANALYZER_SYSTEM_PROMPT,
    GENERATION_SYSTEM_PROMPT,
    RETRIEVAL_SYSTEM_PROMPT,
    SUMMARIZER_SYSTEM_PROMPT,
    REFLECTION_SYSTEM_PROMPT
)

analyzer_template = ChatPromptTemplate(
    [
        (
            "system",
            ANALYZER_SYSTEM_PROMPT
        )
    ]
)

retrieval_template = ChatPromptTemplate(
    [
        (
            "system",
            RETRIEVAL_SYSTEM_PROMPT
        )
    ]
)

summarizer_template = ChatPromptTemplate(
    [
        (
            "system",
            SUMMARIZER_SYSTEM_PROMPT
        )
    ]
)

generation_template = ChatPromptTemplate(
    [
        (
            "system",
            GENERATION_SYSTEM_PROMPT
        )
    ]
)

reflection_template = ChatPromptTemplate(
    [
        (
            "system",
            REFLECTION_SYSTEM_PROMPT
        )
    ]
)
