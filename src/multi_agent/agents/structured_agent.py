from typing import Union

from .agent import Agent

from langchain.prompts import ChatPromptTemplate
from langchain.schema import HumanMessage, AIMessage
from pydantic import BaseModel

class Structured_Agent(Agent):
    """
    A structured-output agent that interacts with an LLM, prepends a system prompt,
    and optionally validates its response against a Pydantic schema.

    Args:
        name (str): 
            The name of the agent, injected into the system prompt.
        llm (Union[ChatOpenAI, ChatAnthropic]): 
            The language model used for generation.
        system_prompt (str): 
            A template string for the system prompt, must include a `{name}` placeholder.
        structure_response (Optional[Type[BaseModel]]): 
            A Pydantic model class to parse and validate the LLM's structured output.
    """
    def __init__(self, *, structure_response, **kwargs):
        # Initialize basic attributes of the agent
        super().__init__(**kwargs)
        self.structure_response = structure_response
        
        # Bind the llm with a structured output if passed
        self.llm = self.llm.with_structured_output(self.structure_response) if self.structure_response else self.llm

    def invoke(self, message: Union[str, HumanMessage, ChatPromptTemplate]) -> Union[AIMessage, BaseModel]:
        """
        Run a single, non-streaming chat turn through the agent.

        Args:
            message (Union[str, HumanMessage, ChatPromptTemplate]):
                The user's input. Can be a raw string, a HumanMessage, or a ChatPromptTemplate.

        Returns:
            If no `structure_response` was provided, the raw LLM response as an AIMessage.
            Otherwise, an instance of the Pydantic `structure_response` model.
        """
        chat_template = self._build_chat_template(message)
        return self.llm.invoke(chat_template.messages)
    
    def stream(self, message: Union[str, HumanMessage, ChatPromptTemplate]) -> Union[AIMessage, BaseModel]:
        """
        This default implementation **does not** perform true token-level streaming;
        it simply delegates to :meth:`invoke` and returns the fully-formed response.
        
        Args:
            message (Union[str, HumanMessage, ChatPromptTemplate]):
                The user's input. Can be a raw string, a HumanMessage, or a ChatPromptTemplate.

        Returns:
            If no `structure_response` was provided, the raw LLM response as an AIMessage.
            Otherwise, an instance of the Pydantic `structure_response` model.
        """
        return self.invoke(message)


