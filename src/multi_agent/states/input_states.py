from pydantic import BaseModel

from typing import Union
from langchain.prompts import ChatPromptTemplate
from langchain.schema import HumanMessage

class InputState(BaseModel):
    user_input: Union[str, HumanMessage, ChatPromptTemplate]
