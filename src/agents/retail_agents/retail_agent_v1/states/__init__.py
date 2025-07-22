from typing import List, Any, Dict, Union
from pydantic import BaseModel
from langchain.schema import BaseMessage
from langchain.prompts import ChatPromptTemplate
from retail_agents.retail_agent_v1.config import TABLE


class RetailV1_State(BaseModel):
    """
    Data model representing the state of a retail agent process in version 1.
    """
    user_input: Union[List[Dict[str, str]], ChatPromptTemplate, List[BaseMessage]]
    user_input_json: str = None
    db_schema_json: str = None
    table_name: str = TABLE
    
    analysis_results: Any = None
    analysis_str: str = None
    
    error_message: str = None
    sql_query: str = None
    sql_results: Any = None
    
    response: str = None
    
    sql_cycle: int = 0
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)




