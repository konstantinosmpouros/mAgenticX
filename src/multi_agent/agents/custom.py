import json
from typing import List, Union, Dict
from langchain_openai import ChatOpenAI

from langchain.prompts import ChatPromptTemplate
from langchain.schema import SystemMessage, HumanMessage, BaseMessage, AIMessage
from langchain_core.messages import ToolMessage, AIMessageChunk
from langchain_core.tools import Tool

from pydantic import BaseModel


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
        chat_template = ChatPromptTemplate.from_messages(chat_template.messages + [response])
        return chat_template

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


class ReAct_Agent(Agent):
    """
    A ReAct-style agent that interacts with an LLM and invokes tools when needed.

    Args:
        name (str): The name of the agent.
        llm (Union[ChatOpenAI, ChatAnthropic]): The language model used for generation.
        system_prompt (SystemMessage): The system prompt wrapped in a SystemMessage.
        tools (Dict[str, Tool]): A mapping of tool names to Tool instances.
    """
    
    def __init__(self, *, tools: Dict[str, Tool], **kwargs):
        # Initialize basic attributes of the agent
        super().__init__(**kwargs)
        self.tools = tools

        # Bind the LLM with the give tools if passed
        self.llm = self.llm.bind_tools(tools.values()) if tools else self.llm

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
        chat_template = ChatPromptTemplate.from_messages(chat_template.messages + [response])

        while self._is_tool_call(response):
            # Execute once the first tool and add it to the history
            call = response.tool_calls.pop(0)
            tool_results = self._execute_tool(call)
            chat_template = ChatPromptTemplate.from_messages(
                chat_template.messages + [tool_results]
            )
            
            # If there are more tools to execute, repeat the process but add in the middle of an AIMessage
            while response.tool_calls:
                call = response.tool_calls.pop(0)
                tool_results = self._execute_tool(call)

                # Build a *new* template that includes everything so far plus the tool result
                chat_template = ChatPromptTemplate.from_messages(
                    chat_template.messages + [AIMessage(content="", tool_calls=[call]), tool_results]
                )

            # Run the inference again.
            response = self.llm.invoke(chat_template.messages)

            chat_template = ChatPromptTemplate.from_messages(
                chat_template.messages + [response]
            )
        
        return chat_template

    def stream(self, message: Union[str, HumanMessage, ChatPromptTemplate]):
        """
        Stream the agent's response content, handling tool calls incrementally.

        Args:
            message (Union[str, HumanMessage, ChatPromptTemplate]): The user message or prompt template.

        Yields:
            str: Content chunks from the LLM's streaming output.
        """
        chat_template = self._build_chat_template(message)

        tool_calls = {}
        ai_msg = AIMessage(content="")
        for chunk in self.llm.stream(chat_template.messages):
            # Extract tool‑call pieces (if any)
            if getattr(chunk, "tool_call_chunks", None):
                tool_calls = self._stream_tool_content_extraction(chunk, tool_calls)

            # Yield actual text content if provided
            if getattr(chunk, "content", None):
                ai_msg.content += chunk.content
                yield chunk.content

        # ReAct loop – keep going while model asked for tools
        while tool_calls:
            # Take a Tool Message for every tool call we have
            while tool_calls:
                # Pop the first tool call and fix the args
                tool_call = tool_calls.pop(0)
                if isinstance(tool_call['args'], str):
                    tool_call['args'] = json.loads(tool_call['args'])

                # Append in the history an AI Message with the this tool call params
                ai_msg.tool_calls = [tool_call]
                chat_template = ChatPromptTemplate.from_messages(chat_template.messages + [ai_msg])

                # Execute the tool and append the Tool Message in the history
                tool_msgs = self._execute_tool(tool_call)
                chat_template = ChatPromptTemplate.from_messages(chat_template.messages + [tool_msgs])

            # Reset for next round
            tool_calls = {}
            ai_msg = AIMessage(content="")
            for chunk in self.llm.stream(chat_template.messages):
                if getattr(chunk, "tool_call_chunks", None):
                    tool_calls = self._stream_tool_content_extraction(chunk, tool_calls)

                if getattr(chunk, "content", None):
                    ai_msg.content += chunk.content
                    yield chunk.content

    def _is_tool_call(self, ai_message: AIMessage) -> bool:
        """
        Determine if the AIMessage includes a tool call.

        Args:
            ai_message (AIMessage): The model's response message.

        Returns:
            bool: True if there's at least one tool call, False otherwise.
        """
        return bool(getattr(ai_message, "tool_calls", None))

    def _execute_tool(self, call: Dict) -> ToolMessage:
        """
        Execute a specified tool call and wrap the output in a ToolMessage.

        Args:
            call (Dict): A dict containing 'name', 'args', and 'id' for the tool call.

        Returns:
            ToolMessage: The tool invocation result.
        """
        result = self.tools[call['name']].invoke(call['args'])
        return ToolMessage(content=result, tool_call_id=call['id'])

    def _stream_tool_content_extraction(self, chunk: AIMessageChunk, tool_calls: Dict) -> Dict:
        """
        Accumulate streaming chunks of a tool call into a complete call structure.

        Args:
            chunk (AIMessageChunk): A chunk from the LLM containing tool call pieces.
            tool_calls (Dict[int, Dict]): Existing partial tool call data indexed by chunk index.

        Returns:
            Dict ([int, Dict]): Updated mapping of chunk index to complete tool call info.
        """
        for tool_chunk in chunk.tool_call_chunks:
            index = tool_chunk['index']
            if index not in tool_calls:
                tool_calls[index] = {
                    'name': tool_chunk['name'],  # might be None at first
                    'args': '',
                    'id': tool_chunk['id']
                }
            if tool_chunk['name'] is not None:
                tool_calls[index]['name'] = tool_chunk['name']
            if tool_chunk['args']:
                tool_calls[index]['args'] += tool_chunk['args']
        return tool_calls


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





