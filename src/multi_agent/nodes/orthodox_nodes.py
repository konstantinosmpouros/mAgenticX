from ..states import Orthodox_State
from ..agents.orthodox_agent import (
    analysis_agent,
    reflection_agent,
    query_gen_agent,
    generation_agent,
    summarizer_agent
)

from langgraph.types import Command
from langgraph.graph import END
from typing import Literal

from ..rag import get_openai_retriever
from ..prompts.templates import (
    summarization_prompt,
    nonreligious_gen_template,
    religious_gen_template,
    no_reflection_template,
    with_reflection_template,
    reflection_template
)
import json


def analysis(state: Orthodox_State) -> Orthodox_State:
    user_msg = state['user_input']
    analysis_result = analysis_agent.invoke(user_msg)
    return {'analysis_results': analysis_result}


def check_if_religious(state: Orthodox_State) -> Command[Literal["node_b", "node_c"]]:
    return Command(
        goto='query_gen' if state['analysis_results'].is_religious == "Religious" else 'generation'
    )


def query_gen(state: Orthodox_State) -> Orthodox_State:
    analysis_result = state['analysis_results']
    reflection = state["reflection"]
    
    if reflection:
        # render the template with both analysis + reflection
        prompt = with_reflection_template.format_prompt(
            analysis_results=analysis_result.json(),
            reflection=reflection.json()
        )
    else:
        # render the template with only analysis
        prompt = no_reflection_template.format_prompt(
            analysis_results=analysis_result.json()
        )
    
    response = query_gen_agent.invoke(prompt)
    return {"vector_queries": response.queries}


retriever = get_openai_retriever(k=10)
def retrieval(state: Orthodox_State) -> Orthodox_State:
    retrieved_docs = []
    for query in state['vector_queries']:
        docs = retriever.invoke(query)
        
        for i, doc in enumerate(docs):
            retrieved_docs.append({"Content:": doc.page_content.replace("\n", " "),
                                "Metadata:": doc.metadata})
    return {"retrieved_content": retrieved_docs}


def summarization(state: Orthodox_State) -> Orthodox_State:
    retrieved_docs = state['retrieved_content']
    analysis_str = state['analysis_results'].json()
    docs_json  = json.dumps(retrieved_docs, ensure_ascii=False, indent=2)
    chat_input = summarization_prompt.format_prompt(retrieved_docs=docs_json, analysis_results=analysis_str)
    summarization = summarizer_agent.invoke(chat_input)
    return {"summarization": summarization.content}


def generation(state: Orthodox_State):
    analysis = state["analysis_results"]
    analysis_str = analysis.json()
    
    if analysis.is_religious == "Religious":
        # pull in the summary from state
        summary = state["summarization"]
        # render the chat prompt
        prompt = religious_gen_template.format_prompt(
            summarization=summary,
            analysis_results=analysis_str,
        )
        goto='reflection'
    else:
        # non-religious branch
        prompt = nonreligious_gen_template.format_prompt(
            analysis_results=analysis_str,
        )
        goto=END
    
    # invoke the generation agent
    response = generation_agent.invoke(prompt)
    return {"response": response.content}


def check_generation(state: Orthodox_State):
    return Command(
        goto='reflection' if state['analysis_results'].is_religious == "Religious" else END
    )


def reflection(state: Orthodox_State):
    analysis_json = state["analysis_results"].json()
    gen_resp = state["response"]
    
    prompt = reflection_template.format_prompt(
        analysis_results=analysis_json,
        generated_response=gen_resp,
    )
    
    # Invoke your reflection agent
    reflection = reflection_agent.invoke(prompt)
    return {"reflection": reflection}


def check_reflection(state: Orthodox_State):
    return Command(
        goto='query_gen' if state['reflection'].requires_additional_retrieval else END
    )
