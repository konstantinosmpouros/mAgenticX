from .input_states import InputState
from typing import List, Union, Any
from langchain.prompts import ChatPromptTemplate
from langchain.schema import HumanMessage

class Orthodox_State(InputState):
    analysis_results: Any
    vector_queries: List[str]
    retrieved_content: List[str]
    summarization: Union[str, HumanMessage, ChatPromptTemplate]
    reflection: Any
    response: str




