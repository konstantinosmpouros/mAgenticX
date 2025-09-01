from langchain_anthropic import ChatAnthropic

from hr_agents.hr_policies_agent_v1.config import (
    ANTHROPIC_3_5_SONNET,
    ANTHROPIC_3_5_HAIKU,
    ANTHROPIC_3_7_SONNET
)

anthropic_3_7_sonnet = ChatAnthropic(model=ANTHROPIC_3_7_SONNET)

anthropic_3_5_sonnet = ChatAnthropic(model=ANTHROPIC_3_5_SONNET)
anthropic_3_5_haiku = ChatAnthropic(model=ANTHROPIC_3_5_HAIKU)





