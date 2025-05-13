from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

import json
from states import Orthodox_State
from typing import Literal
from agents import (
    analysis_agent,
    simple_gen_agent,
    reflection_agent,
    query_reflective_agent,
    query_no_reflective_agent,
    complex_gen_agent,
    summarizer_agent
)

from rag import get_openai_retriever


def analysis(state: Orthodox_State) -> Orthodox_State:
    user_msg = state['user_input']
    analysis_results = analysis_agent.invoke(user_msg)
    analysis_str = (
        f"This question is **{analysis_results.is_religious}** and focuses on **{', '.join(analysis_results.key_topics)}**.  \n"
        f"Context requirements: {analysis_results.context_requirements}.  \n"
        f"Overall complexity: **{analysis_results.query_complexity}**.  \n"
        f"Reasoning: {analysis_results.reasoning}"
    )
    return {'analysis_results': analysis_results, 'analysis_str': analysis_str}


def check_if_religious(state: Orthodox_State) -> Literal["query_gen", "simple_generation"]:
    return 'query_gen' if state['analysis_results'].is_religious == "Religious" else 'simple_generation'


def simple_generation(state: Orthodox_State) -> Orthodox_State:
    analysis_str = state["analysis_str"]
    
    # invoke the generation agent
    response = simple_gen_agent.invoke(analysis_str)
    return {"response": response.content}


def query_gen(state: Orthodox_State) -> Orthodox_State:
    analysis_str = state['analysis_str']
    reflection = state["reflection_str"]
    
    if reflection:
        payload = {
            'analysis_results': analysis_str,
            'reflection': reflection,
        }
        response = query_reflective_agent.invoke(payload)
    else:
        payload = {
            'analysis_results': analysis_str,
        }
        response = query_no_reflective_agent.invoke(payload)
    
    return {"vector_queries": response.queries}


retriever = get_openai_retriever(k=10)
def retrieval(state: Orthodox_State) -> Orthodox_State:
    retrieved_docs = []
    for query in state['vector_queries']:
        docs = retriever.invoke(query)
        
        for doc in docs:
            retrieved_docs.append({"Content:": doc.page_content.replace("\n", " "),
                                "Metadata:": doc.metadata})
    docs_json  = json.dumps(retrieved_docs, ensure_ascii=False, indent=2)
    return {"retrieved_content": docs_json}


def summarization(state: Orthodox_State) -> Orthodox_State:
    retrieved_docs = state['retrieved_content']
    analysis_str = state['analysis_str']
    
    payload = {
        "retrieved_docs": retrieved_docs,
        "analysis_results": analysis_str,
    }
    
    summarization = summarizer_agent.invoke(payload)
    return {"summarization": summarization.content}


def complex_generation(state: Orthodox_State) -> Orthodox_State:
    analysis_str = state["analysis_str"]
    summary = state["summarization"]
    
    # render the chat prompt
    payload = {
        "summarization": summary,
        "analysis_results": analysis_str,
    }
    
    # invoke the generation agent
    response = complex_gen_agent.invoke(payload)
    return {"response": response.content}


def reflection(state: Orthodox_State) -> Orthodox_State:
    analysis_str = state["analysis_str"]
    gen_resp = state["response"]
    
    payload = {
        "analysis_results": analysis_str,
        "generated_response": gen_resp,
    }
    
    # Invoke your reflection agent
    reflection = reflection_agent.invoke(payload)
    reflection_str = (
        f"Additional retrieval needed: **{'Yes' if reflection.requires_additional_retrieval else 'No'}**.  \n"
        f"Reflection: {reflection.reflection}.  \n"
        f"Recommended next steps: {reflection.recommended_next_steps}"
        if reflection.requires_additional_retrieval else
        f"No additional retrieval is required."
    )
    return {"reflection": reflection, 'reflection_str': reflection_str}


def check_reflection(state: Orthodox_State) -> Literal["query_gen", "end"]:
    return 'query_gen' if state['reflection'].requires_additional_retrieval else 'end'


