from typing import List, Any, Dict, Union
from pydantic import BaseModel
from langchain.schema import BaseMessage
from langchain.prompts import ChatPromptTemplate


class HRPoliciesV1_State(BaseModel):
    user_input: Union[List[Dict[str, str]], ChatPromptTemplate, List[BaseMessage]]
    
    analysis_results: Any = None
    analysis_str: str = None
    
    vector_queries: List[str] = None
    retrieved_content: List[Dict] = None
    summarization: str = None
    
    reflection: Any = None
    reflection_str: str = None
    
    response: str = None
    
    cycle_numbers: int = 0
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)




