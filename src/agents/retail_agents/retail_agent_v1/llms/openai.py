from langchain_openai import ChatOpenAI

from retail_agents.retail_agent_v1.config import (
    OPENAI_GPT_4o,
    OPENAI_GPT_4_1_MINI,
    OPENAI_GPT_4_1,
    OPENAI_GPT_o4_MINI,
    OPENAI_GPT_o3_MINI,
    OPENAI_GPT_o1_MINI
)

gpt_o4_mini = ChatOpenAI(model=OPENAI_GPT_o4_MINI)
gpt_o3_mini = ChatOpenAI(model=OPENAI_GPT_o3_MINI)
gpt_o1_mini = ChatOpenAI(model=OPENAI_GPT_o1_MINI)

gpt_4o = ChatOpenAI(model=OPENAI_GPT_4o)
gpt_4_1_mini = ChatOpenAI(model=OPENAI_GPT_4_1_MINI)
gpt_4_1 = ChatOpenAI(model=OPENAI_GPT_4_1)


