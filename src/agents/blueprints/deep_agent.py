from typing import Any, List, Mapping, Optional, Literal, Set
from abc import abstractmethod, ABC

from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.serde.types import INTERRUPT

from agui import AGUIEmitter, AGUIStreamNormalizer
from blueprints.base_agent import BaseAgent


STREAMING_MODES = Literal["updates", "messages"]
RESERVED_DEEPAGENT_TOOL_NAMES: Set[str] = {
    # planning
    "write_todos",
    
    # filesystem + execute
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "execute",
    
    # delegation
    "task",
}

class DeepAgent(BaseAgent, ABC):
    
    # Default streaming mode for LangGraph inference
    stream_mode: List[STREAMING_MODES] = ["messages", "updates"]
    
    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        # Configuration
        super().__init__(config=config)
        
        # Agent components
        self.memory_saver: MemorySaver = MemorySaver()
        self.sub_agents: Any = None
        self.agent: Any = None
        
        # AGUI components
        self.agui_emitter: AGUIEmitter = AGUIEmitter()
        self.agui_normalizer: AGUIStreamNormalizer = AGUIStreamNormalizer(stream_mode=self.stream_mode)



    # ---------------------------------------------------------------------
    # Workflow lifecycle
    # ---------------------------------------------------------------------
    @abstractmethod
    def register_subagents(self) -> None:
        """Instantiate nested agents if any."""
        return


    @abstractmethod
    def register_agent(self) -> None:
        """Instantiate the main agent."""
        return


    def build(self) -> None:
        """Build the DeepAgent by registering sub-agents and the main agent."""
        if self.agent is None:
            self.sub_agents = self.register_subagents()
            self.agent = self.register_agent()
        return



    # ---------------------------------------------------------------------
    # Streaming interface
    # ---------------------------------------------------------------------
    async def astream(self, inputs: Mapping[str, Any]) -> Any:
        """Asynchronous generator that streams agent outputs in AG-UI format.

        Args:
            inputs: Input mapping for the agent.
        Yields:
            Streamed chunks in AG-UI format.
        """
        # Ensure the agent is built
        self.build()
