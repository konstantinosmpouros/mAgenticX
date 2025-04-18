from typing import Dict, Union

from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic

from langchain.prompts import ChatPromptTemplate
from langchain.schema import HumanMessage, SystemMessage, AIMessage
from langchain_core.messages import ToolMessage

class Structure_Agent:
    
    def __init__(self,
                name: str,
                llm: Union[ChatOpenAI, ChatAnthropic],
                system_prompt: str,
                structure_response = None):
        # Initialize basic attributes of the agent
        self.name = name
        self.llm = llm
        self.system_prompt = SystemMessage(system_prompt.format(name=self.name))
        self.structure_response = structure_response
        
        self.llm = self.llm.with_structured_output(self.structure_response) if self.structure_response else self.llm
    

    def invoke(self):
        pass
    
    def stream(self):
        self.invoke()












