from typing import List, Literal
from langchain_core.tools import Tool

from langchain_openai import ChatOpenAI

from langgraph.graph import END, START, StateGraph, MessagesState
from langgraph.prebuilt import ToolNode


def react_agent(model_name: str, tools: List[Tool]):
    def call_model(state: MessagesState):
        messages = state['messages']
        response = llm.invoke(messages)
        return {"messages": [response]}
    
    def should_continue(state: MessagesState) -> Literal["tools", END]: # type: ignore
        return "tools" if state["messages"][-1].tool_calls else END
    
    # Initialize the llm that we will use
    llm = ChatOpenAI(model=model_name).bind_tools(tools)
    
    # Initialize the workflow and the tool node
    workflow = StateGraph(MessagesState)
    tool_node = ToolNode(tools)
    
    # Initialize the nodes
    workflow.add_node("react_agent", call_model)
    workflow.add_node("tools", tool_node)
    
    # Initialize the edges
    workflow.add_edge(START, "react_agent")
    workflow.add_conditional_edges(
        "react_agent",
        should_continue,
    )
    workflow.add_edge("tools", "react_agent")
    
    # Compile and return the graph
    return workflow.compile()
    
    