from typing import Any, List, Union

from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic

from langchain.prompts import ChatPromptTemplate
from langchain.schema import HumanMessage, SystemMessage, AIMessage
from pydantic import BaseModel

class Structured_Agent:
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

    def _build_chat_template(self,
                            message: Union[str, HumanMessage, ChatPromptTemplate]) -> ChatPromptTemplate:
        """
        Construct a ChatPromptTemplate from a user message, prepending the system prompt.

        Args:
            message (Union[str, HumanMessage, ChatPromptTemplate]): The incoming message.

        Returns:
            ChatPromptTemplate: Combined system prompt and user message template.
        """
        if isinstance(message, str):
            user_msg = HumanMessage(content=message)
            return ChatPromptTemplate.from_messages([self.system_prompt, user_msg])
        
        if isinstance(message, HumanMessage):
            return ChatPromptTemplate.from_messages([self.system_prompt, message])
        
        if isinstance(message, ChatPromptTemplate):
            # Avoid duplicating a system prompt if the caller already supplied one.
            non_system: List[Any] = [m for m in message.messages if not isinstance(m, SystemMessage)]
            chat_template = ChatPromptTemplate.from_messages([self.system_prompt, *non_system])
            return ChatPromptTemplate(chat_template.format_messages())

        raise TypeError(
            "message must be str, HumanMessage or ChatPromptTemplate, "
            f"got {type(message).__name__}"
        )

