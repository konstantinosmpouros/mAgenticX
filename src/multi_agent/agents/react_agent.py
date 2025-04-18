import json
from typing import Dict, Union, List, Any

from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic

from langchain.prompts import ChatPromptTemplate
from langchain.schema import HumanMessage, SystemMessage, AIMessage
from langchain_core.messages import ToolMessage, AIMessageChunk
from langchain_core.tools import Tool

class ReAct_Agent:
    """
    A ReAct-style agent that interacts with an LLM and invokes tools when needed.

    Args:
        name (str): The name of the agent.
        llm (Union[ChatOpenAI, ChatAnthropic]): The language model used for generation.
        system_prompt (SystemMessage): The system prompt wrapped in a SystemMessage.
        tools (Dict[str, Tool]): A mapping of tool names to Tool instances.
    """
    
    def __init__(self,
                name: str,
                llm: Union[ChatOpenAI, ChatAnthropic],
                system_prompt: str,
                tools: Dict[str, Tool] = []):
        # Initialize basic attributes of the agent
        self.name = name
        self.llm = llm
        self.tools = tools
        self.system_prompt = SystemMessage(system_prompt.format(name=self.name))

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

