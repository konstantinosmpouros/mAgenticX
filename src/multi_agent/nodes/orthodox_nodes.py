from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

import json
from states import Orthodox_State
from agents.orthodox_agent import (
    analysis_agent,
    reflection_agent,
    query_gen_agent,
    generation_agent,
    summarizer_agent
)

from langgraph.types import Command
from langgraph.graph import END
from typing import Literal

from rag import get_openai_retriever
from prompts.templates import (
    summarization_prompt,
    nonreligious_gen_template,
    religious_gen_template,
    no_reflection_template,
    with_reflection_template,
    reflection_template
)


def analysis(state: Orthodox_State) -> Orthodox_State:
    user_msg = state['user_input']
    analysis_result = analysis_agent.invoke(user_msg)
    return {'analysis_results': analysis_result}


def check_if_religious(state: Orthodox_State):
    return 'query_gen' if state['analysis_results'].is_religious == "Religious" else 'simple_generation'


def simple_generation(state: Orthodox_State) -> Orthodox_State:
    analysis = state["analysis_results"]
    analysis_str = analysis.model_dump_json()

    # non-religious branch
    prompt = nonreligious_gen_template.format_prompt(
        analysis_results=analysis_str,
    )
    
    # invoke the generation agent
    response = generation_agent.invoke(prompt)
    return {"response": response.messages[-1]}


def query_gen(state: Orthodox_State) -> Orthodox_State:
    analysis_result = state['analysis_results']
    reflection = state["reflection"]
    
    if reflection:
        # render the template with both analysis + reflection
        prompt = with_reflection_template.format_prompt(
            analysis_results=analysis_result.model_dump_json(),
            reflection=reflection.model_dump_json()
        )
    else:
        # render the template with only analysis
        prompt = no_reflection_template.format_prompt(
            analysis_results=analysis_result.model_dump_json()
        )
    
    response = query_gen_agent.invoke(prompt)
    return {"vector_queries": response.queries}


retriever = get_openai_retriever(k=10)
def retrieval(state: Orthodox_State) -> Orthodox_State:
    retrieved_docs = []
    for query in state['vector_queries']:
        docs = retriever.invoke(query)
        
        for doc in docs:
            retrieved_docs.append({"Content:": doc.page_content.replace("\n", " "),
                                "Metadata:": doc.metadata})
    return {"retrieved_content": retrieved_docs}


def summarization(state: Orthodox_State) -> Orthodox_State:
    retrieved_docs = state['retrieved_content']
    analysis_str = state['analysis_results'].model_dump_json()
    docs_json  = json.dumps(retrieved_docs, ensure_ascii=False, indent=2)
    chat_input = summarization_prompt.format_prompt(retrieved_docs=docs_json, analysis_results=analysis_str)
    summarization = summarizer_agent.invoke(chat_input)
    return {"summarization": summarization.content}


def complex_generation(state: Orthodox_State) -> Orthodox_State:
    analysis = state["analysis_results"]
    analysis_str = analysis.model_dump_json()
    summary = state["summarization"]
    
    # render the chat prompt
    prompt = religious_gen_template.format_prompt(
        summarization=summary,
        analysis_results=analysis_str,
    )
    
    # invoke the generation agent
    response = generation_agent.invoke(prompt)
    return {"response": response.messages[-1]}


def reflection(state: Orthodox_State) -> Orthodox_State:
    analysis_json = state["analysis_results"].model_dump_json()
    gen_resp = state["response"]
    
    prompt = reflection_template.format_prompt(
        analysis_results=analysis_json,
        generated_response=gen_resp,
    )
    
    # Invoke your reflection agent
    reflection = reflection_agent.invoke(prompt)
    return {"reflection": reflection}


def check_reflection(state: Orthodox_State):
    return 'query_gen' if state['reflection'].requires_additional_retrieval else 'end'
