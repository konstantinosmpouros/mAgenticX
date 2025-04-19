from typing import List, Union
from langchain_openai import ChatOpenAI

from langchain.prompts import ChatPromptTemplate
from langchain.schema import SystemMessage, HumanMessage, BaseMessage


class Agent:
    """
    Base agent class encapsulating shared initialization, prompt building and invoking and streaming results.

    Args:
        name (str): Name of the agent.
        llm (ChatOpenAI): Language model instance.
        system_prompt (str): Template for the system prompt (must include `{name}`).
    """
    def __init__(self, *, name: str, llm: ChatOpenAI, system_prompt: str):
        self.name = name
        self.llm = llm
        self.system_prompt = SystemMessage(system_prompt.format(name=self.name))

    def invoke(self, message: Union[str, HumanMessage, ChatPromptTemplate]):
        """
        Invoke the agent with the given message, handling tool calls in a ReAct loop.

        Args:
            message (Union[str, HumanMessage, ChatPromptTemplate]): The user message or prompt template.

        Returns:
            ChatPromptTemplate: The final chat template containing the full conversation.
        """
        chat_template = self._build_chat_template(message)
        response = self.llm.invoke(chat_template.messages)
        return response

    def stream(self, message: Union[str, HumanMessage, ChatPromptTemplate]):
        """
        Stream the agent's response content, handling tool calls incrementally.

        Args:
            message (Union[str, HumanMessage, ChatPromptTemplate]): The user message or prompt template.

        Yields:
            str: Content chunks from the LLM's streaming output.
        """
        chat_template = self._build_chat_template(message)
        for chunk in self.llm.stream(chat_template.messages):
            yield chunk.content

    def _build_chat_template(self, message: Union[str, HumanMessage, ChatPromptTemplate]) -> ChatPromptTemplate:
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
            non_system: List[BaseMessage] = [m for m in message.messages if not isinstance(m, SystemMessage)]
            chat_template = ChatPromptTemplate.from_messages([self.system_prompt, *non_system])
            return ChatPromptTemplate(chat_template.format_messages())

        raise TypeError(
            "message must be str, HumanMessage or ChatPromptTemplate, "
            f"got {type(message).__name__}"
        )
