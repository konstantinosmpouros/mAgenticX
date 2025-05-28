from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

from langchain.prompts import ChatPromptTemplate
from prompts.system.orthodoxai_v1 import (
    ANALYZER_SYSTEM_PROMPT,
    GENERATION_SYSTEM_PROMPT,
    REFLECTION_SYSTEM_PROMPT,
    RETRIEVAL_SYSTEM_PROMPT,
    SUMMARIZER_SYSTEM_PROMPT,
)

analyzer_template = ChatPromptTemplate.from_messages([
    ("system", ANALYZER_SYSTEM_PROMPT),
    ("human",
    """
        The message to analyze is the following:

        {user_msg}
    """
    ),
])


summarization_template = ChatPromptTemplate.from_messages([
    ("system", SUMMARIZER_SYSTEM_PROMPT),
    ("human",
    """
        Below is a JSON array of retrieved documents (each with metadata and content):

        {retrieved_docs}

        Please write a concise, coherent summary of the above documents that can help answer the following user question (represented by the analysis results):

        {analysis_results}
    """
    ),
])


religious_gen_template = ChatPromptTemplate.from_messages([
    ("system", GENERATION_SYSTEM_PROMPT),
    ("human",
    """
        Here is the summary of the documents retrieved relevant to the user question content:\n\n
        {summarization}

        \n\nHere are the structured analysis results of the user query:\n\n
        {analysis_results}

        \n\nPlease use both of these to write a thoughtful, reflective response.
    """)
])


nonreligious_gen_template = ChatPromptTemplate.from_messages([
    ("system", GENERATION_SYSTEM_PROMPT),
    ("human",
    """
        The content was analyzed as non-religious. These are the structured analysis results of the user query to answer:\n\n
        {analysis_results}

        \n\nPlease write an appropriate response based on this analysis.
    """)
])


query_gen_no_reflection_template = ChatPromptTemplate.from_messages([
    ("system", RETRIEVAL_SYSTEM_PROMPT),
    ("human",
    """
        Here are the structured analysis results of the user query (in JSON):
        {analysis_results}

        Please generate a list of concise search queries that will retrieve the most relevant vector embeddings to address these analysis findings.
    """),
])


query_gen_with_reflection_template = ChatPromptTemplate.from_messages([
    ("system", RETRIEVAL_SYSTEM_PROMPT),
    ("human",
    """
        Here are the structured analysis results of the user query (in JSON):
        {analysis_results}

        Here is the reflective response of what was missing and drawbacks of the previous response generated:
        {reflection}

        Please generate a list of concise search queries that will retrieve the most relevant vector embeddings to address both the analysis and the reflection.
    """),
])


reflection_template = ChatPromptTemplate.from_messages([
    ("system", REFLECTION_SYSTEM_PROMPT),
    ("human",
    """
        Below are the structured analysis results of the user query (in JSON form):

        <analysis>
        {analysis_results}
        </analysis>

        And here is the last response that was generated from those results:

        <response>
        {generated_response}
        </response>

        Based on both the analysis and that response, please write a concise, thoughtful reflection that:
        - Highlights any deeper insights or implications
        - Notes any unanswered questions or needed areas for further exploration
        - Connects the analysis to the response in a coherent way
    """),
])

