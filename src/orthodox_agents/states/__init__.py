from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

from typing import List, Any, Dict, Union
from pydantic import BaseModel
from langchain.schema import HumanMessage
from langchain.prompts import ChatPromptTemplate

class OrthodoxV1_State(BaseModel):
    user_input: Union[str, HumanMessage, ChatPromptTemplate]
    
    analysis_results: Any = None
    analysis_str: str = None
    
    vector_queries: List[str] = None
    retrieved_content: List[Dict] = None
    summarization: str = None
    
    reflection: Any = None
    reflection_str: str = None
    
    response: str = None
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)




