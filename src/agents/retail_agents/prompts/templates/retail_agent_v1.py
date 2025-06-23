from langchain.prompts import ChatPromptTemplate
from retail_agents.prompts.system.retail_agent_v1 import (
    ANALYSIS_SYSTEM_PROMPT,
    SCHEMA_HELP_SYSTEM_PROMPT,
    SQL_GEN_SYSTEM_PROMPT,
    ANSWER_SYSTEM_PROMPT
)

analyzer_template = ChatPromptTemplate.from_messages([
    ("system", ANALYSIS_SYSTEM_PROMPT),
])


schema_help_template = ChatPromptTemplate.from_messages([
    ("system", SCHEMA_HELP_SYSTEM_PROMPT),
    ("human",
    """ 
        Here is the user's query:
        <user_question>
            {user_input_json}
        </user_question>
        
        Here is the analysis of the user's query:
        <analysis_str>
            {analysis_str}
        </analysis_str>
    """
    )
])


sql_gen_template = ChatPromptTemplate.from_messages([
    ("system", SQL_GEN_SYSTEM_PROMPT),
    ("human",
    """
        Here is the user's query:
        <user_question>
            {analysis_str}
        </user_question>
    """),
])


sql_error_gen_template = ChatPromptTemplate.from_messages([
    ("system", SQL_GEN_SYSTEM_PROMPT),
    ("human",
    """
        Here is the user's query:
        <user_question>
            {analysis_str}
        </user_question>
        
        Here is the error message from the SQL engine:
        <previous_error>
            {error_message}
        </previous_error>
        
        Here is the SQL query that caused the error:
        <previous_sql>
            {sql_query}
        </previous_sql>
        
        Please generate a new SQL query that addresses the error.
        Ensure that the new query is syntactically correct and addresses the issue raised in the error
        message.
    """),
])


answer_gen_template = ChatPromptTemplate.from_messages([
    ("system", ANSWER_SYSTEM_PROMPT),
    ("human",
    """
        Here is the user's query:
        <user_input_json>
        {user_input_json}
        </user_input_json>
        
        Here is the analysis of the user's query:
        <analysis_str>
        {analysis_str}
        </analysis_str>
        
        Here are the results of the SQL query:
        <sql_results>
        {sql_results}
        </sql_results>
    """),
])


