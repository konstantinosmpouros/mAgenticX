from typing import List, Any, Dict, Union, Annotated
from pydantic import BaseModel, Field
from langchain.schema import BaseMessage
from langchain.prompts import ChatPromptTemplate
from langgraph.graph import add_messages


class HRPoliciesV1_State(BaseModel):
    user_input: Union[List[Dict[str, str]], ChatPromptTemplate, List[BaseMessage]]
    user_input_json: Any = None
    
    analysis_results: Any = None
    analysis_str: str = None
    
    vector_queries: List[str] = None
    
    retrieved_content: List[List[Dict]] = [[]]
    
    ranking_flags: List[List[bool]] = [[]]
    
    reflection: Any = None
    reflection_str: str = None
    cycle_numbers: int = 0
    formatted_docs_str: str = None
    
    summarization: str = None
    
    response: str = None
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)




