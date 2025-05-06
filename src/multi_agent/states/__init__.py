from .input_states import InputState
from typing import List, Any, Dict

class Orthodox_State(InputState):
    analysis_results: Any
    vector_queries: List[str]
    retrieved_content: List[Dict]
    summarization: str
    reflection: Any
    response: str




