from langchain.prompts import ChatPromptTemplate, HumanMessagePromptTemplate


summarization_prompt = ChatPromptTemplate(
    messages=[
        HumanMessagePromptTemplate.from_template(
            """Below is a JSON array of retrieved documents (each with metadata and content):

            {retrieved_docs}

            Please write a concise, coherent summary of the above documents that can help answer to the following user question:
            
            {analysis_results}
            
            """
        )
    ],
    input_variables=["retrieved_docs", "analysis_results"],
)


religious_gen_template = ChatPromptTemplate(
    messages=[
        HumanMessagePromptTemplate.from_template(
            """Here is the summary of the documents retrieved relevant to the user question content:
            {summarization}

            Here are the structured analysis results of the user query:
            {analysis_results}

            Please use both of these to write a thoughtful, reflective response."""
        )
    ],
    input_variables=["summarization", "analysis_results"],
)


nonreligious_gen_template = ChatPromptTemplate(
    messages=[
        HumanMessagePromptTemplate.from_template(
            """The content was analyzed as non-religious. These are the structured analysis results of the user query to answer:
            {analysis_results}

            Please write an appropriate response based on this analysis."""
        )
    ],
    input_variables=["analysis_results"],
)

no_reflection_template = ChatPromptTemplate(
    messages=[
        HumanMessagePromptTemplate.from_template(
            """Here are the structured analysis results of the user query (in JSON):
            {analysis_results}

            Please generate a list of concise search queries that will retrieve the most relevant vector embeddings to address these analysis findings.
            """
        )
    ],
    input_variables=["analysis_results"],
)

with_reflection_template = ChatPromptTemplate(
    messages=[
        HumanMessagePromptTemplate.from_template(
            """Here are the structured analysis results of the user query (in JSON):
            {analysis_results}

            Here is the reflective response of what was missing and drawbacks of the previous response generated:
            {reflection}

            Please generate a list of concise search queries that will retrieve the most relevant vector embeddings to address both the analysis and the reflection.
            """
        )
    ],
    input_variables=["analysis_results", "reflection"],
)

reflection_template = ChatPromptTemplate(
    messages=[
        HumanMessagePromptTemplate.from_template(
            """Below are the structured analysis results of the user query (in JSON form):
            
            <analysis>
            {analysis_results}
            </analysis>
            
            And here is the last response that was generated from those results:
            
            <response>
            {generated_response}
            </response>
            
            Based on both the analysis and that response, please write a concise, thoughtful reflection that:
            - Highlights any deeper insights or implications
            - Notes any unanswered questions or needed areas for further exploration
            - Connects the analysis to the response in a coherent way
            """
        )
    ],
    input_variables=["analysis_results", "generated_response"],
)

