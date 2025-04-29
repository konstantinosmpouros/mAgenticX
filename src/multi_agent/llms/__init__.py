from .llm import (
    llm_1,
    resoning_llm_1,
    resoning_llm_2,
    resoning_llm_3
)
from .structured_outputs import (
    AnalyzerOutput,
    ReflectionOutput,
    RetrievalQueriesOutput
)

# REFLECTION LLM 
reflection_llm = resoning_llm_1.with_structured_output(ReflectionOutput)

# RETRIEVAL LLM 
retrieval_llm = resoning_llm_2.with_structured_output(RetrievalQueriesOutput)

# ANALYZER LLM 
analyzer_llm = resoning_llm_3.with_structured_output(AnalyzerOutput)
