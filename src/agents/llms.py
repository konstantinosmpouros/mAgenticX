from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic


# ------------------------------------------------------------------
# OpenAI Models
# ------------------------------------------------------------------
OPENAI_GPT_o4_MINI = "o4-mini"
OPENAI_GPT_o3_MINI = "o3-mini"
OPENAI_GPT_o1_MINI = "o1-mini"
OPENAI_GPT_4o = "gpt-4o-2024-08-06"
OPENAI_GPT_4_1_MINI = "gpt-4.1-mini-2025-04-14"
OPENAI_GPT_4_1 = "gpt-4.1-2025-04-14"

gpt_o4_mini = ChatOpenAI(model=OPENAI_GPT_o4_MINI)
gpt_o3_mini = ChatOpenAI(model=OPENAI_GPT_o3_MINI)
gpt_o1_mini = ChatOpenAI(model=OPENAI_GPT_o1_MINI)
gpt_4o = ChatOpenAI(model=OPENAI_GPT_4o)
gpt_4_1_mini = ChatOpenAI(model=OPENAI_GPT_4_1_MINI)
gpt_4_1 = ChatOpenAI(model=OPENAI_GPT_4_1)



# ------------------------------------------------------------------
# Anthropic Models
# ------------------------------------------------------------------
ANTHROPIC_3_7_SONNET = "claude-3-7-sonnet-latest"
ANTHROPIC_3_5_SONNET = "claude-3-5-sonnet-latest"
ANTHROPIC_3_5_HAIKU = "claude-3-5-haiku-latest"

anthropic_3_7_sonnet = ChatAnthropic(model=ANTHROPIC_3_7_SONNET)
anthropic_3_5_sonnet = ChatAnthropic(model=ANTHROPIC_3_5_SONNET)
anthropic_3_5_haiku = ChatAnthropic(model=ANTHROPIC_3_5_HAIKU)

