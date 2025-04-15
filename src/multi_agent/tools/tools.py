# Annotations
from langchain.tools import tool
from typing import List

# Helper functions for the tools
import requests
import PyPDF2
import io
import textwrap

# Main libraries to create the tools
from pytrends.request import TrendReq
from langchain_community.utilities.wikipedia import WikipediaAPIWrapper
from langchain_community.tools.wikidata.tool import WikidataAPIWrapper, WikidataQueryRun
from langchain_community.tools.openai_dalle_image_generation import OpenAIDALLEImageGenerationTool
from langchain_community.utilities.dalle_image_generator import DallEAPIWrapper
from langchain_community.utilities import (
    PubMedAPIWrapper,
    AlphaVantageAPIWrapper,
    ArxivAPIWrapper
)
from langchain_community.retrievers import ArxivRetriever
from crewai_tools import CodeInterpreterTool

# Input schemas for all the tools
from .args_schema import (
    SearchGoogleTrendsInput,
    SearchPubmedInput,
    SearchWikidataInput,
    SearchWikipediaInput,
    RetrieveArxivArticlesContentInput,
    RetrieveArxivArticlesSummariesInput,
    GetCurrentStockDataInput,
    GetDailyStockDataInput,
    GetStockMarketNewsInput,
    GetTopGainersLosersStockDataInput,
    GetWeeklyStockDataInput,
    ExecutesPythonCodeInput,
    ImageGenerationInput
)

#TODO: Check how to add long-term memory


@tool("search_wikidata", args_schema=SearchWikidataInput)
def search_wikidata(query: str) -> str:
    """
    Searches Wikidata for a given query and returns the results.

    Args:
        query (str): The search term to look up in Wikidata.

    Returns:
        str: The retrieved information from Wikidata.
    """
    try:
        wikidata = WikidataQueryRun(api_wrapper=WikidataAPIWrapper())
        results = wikidata.run(query)
        
        if not results.strip():
            return f"No results found for '{query}' on Wikidata."

        return f"Wikidata Search Results for '{query}':\n{results}"
    
    except Exception as e:
        return f"Error searching Wikidata: {str(e)}"

@tool("search_wikipedia", args_schema=SearchWikipediaInput)
def search_wikipedia(query: str) -> str:
    """
    Searches Wikipedia for a given query and returns a summary.

    Args:
        query (str): The search term to look up in Wikipedia.

    Returns:
        str: A summary of the Wikipedia page found.
    """
    try:
        wikipedia = WikipediaAPIWrapper()
        results = wikipedia.run(query)
        
        if not results.strip():
            return f"No results found for '{query}' on Wikipedia."

        return f"Wikipedia Summary for '{query}':\n{results}"
    
    except Exception as e:
        return f"Error searching Wikipedia: {str(e)}"

@tool("search_google_trends", args_schema=SearchGoogleTrendsInput)
def search_google_trends(keywords: List[str], timeframe: str = 'today 12-m') -> str:
    """
    Retrieves Google Trends data for given keywords over a specified timeframe.

    Args:
        keywords (List[str]): List of keywords to search on Google Trends.
        timeframe (str): Timeframe for the trends data (default: 'today 12-m').

    Returns:
        str: Formatted Google Trends data (interest over time).
    """
    try:
        # Initialize pytrends
        pytrends = TrendReq(hl='en-US', tz=360)
        
        # Build payload
        pytrends.build_payload(keywords, cat=0, timeframe=timeframe, geo='', gprop='')
        
        # Fetch interest over time
        data = pytrends.interest_over_time()
        
        if data.empty:
            return "No Google Trends data found for the given keywords."

        # Convert data to a readable format
        data.reset_index(inplace=True)
        trends_data = data.to_string(index=False)

        return f"Google Trends Data:\n{trends_data}"
    
    except Exception as e:
        return f"Error retrieving Google Trends data: {str(e)}"

@tool("search_pubmed", args_schema=SearchPubmedInput)
def search_pubmed(query: str) -> str:
    """
    Searches PubMed for biomedical literature related to the given query.

    Args:
        query (str): The search term to look up in PubMed.

    Returns:
        str: The retrieved PubMed search results or an error message.
    """
    try:
        # Initialize PubMed API Wrapper
        pubmed = PubMedAPIWrapper()

        # Execute the search
        results = pubmed.run(query)

        # Check if results were retrieved
        if not results.strip():
            return f"No results found for '{query}' on PubMed."

        return f"PubMed Search Results for '{query}':\n{results}"

    except Exception as e:
        return f"Error searching PubMed: {str(e)}"

@tool("retrieve_arxiv_articles_content", args_schema=RetrieveArxivArticlesContentInput)
def retrieve_arxiv_articles_content(query: str) -> list:
    """
    Retrieve academic papers content from ArXiv based on a search query.

    Parameters:
        query (str): The search query string to retrieve relevant papers content from arXiv.

    Returns:
        list: A list of dictionaries, where each dictionary includes the following keys:
            - 'title' (str):        The paper's title.
            - 'authors' (list/str): A list or string of authors.
            - 'pdf_url' (str):      The direct PDF URL on arXiv.
            - 'pdf_text' (list):    A list of strings, each entry corresponding to one page of the PDF.
            - 'error' (str):        If any error occurs during PDF retrieval or parsing, 
                                    this will contain the error message; otherwise it is None.
    """

    # 1) Initialize the ArXiv retriever and get documents
    retriever = ArxivRetriever(load_max_docs=3)
    docs = retriever.invoke(query)

    results = []

    for doc in docs:
        # Some basic metadata
        title = doc.metadata.get("Title", "Unknown Title")
        authors = doc.metadata.get("Authors", "Unknown Authors")
        entry_id = doc.metadata.get("Entry ID", "")

        # 2) Build the PDF URL by replacing 'abs' with 'pdf'
        pdf_url = entry_id.replace("abs", "pdf")

        # 3) Fetch the PDF and extract text page by page
        try:
            response = requests.get(pdf_url)
            response.raise_for_status()

            file_like = io.BytesIO(response.content)
            reader = PyPDF2.PdfReader(file_like)

            pdf_text_list = []
            for page_num in range(len(reader.pages)):
                page_text = reader.pages[page_num].extract_text() or ""
                pdf_text_list.append(page_text)

            # 4) Append a structured result
            results.append({
                "title": title,
                "authors": authors,
                "pdf_url": pdf_url,
                "pdf_text": pdf_text_list,
                "error": None
            })

        except Exception as e:
            # If there's a problem, include error info
            results.append({
                "title": title,
                "authors": authors,
                "pdf_url": pdf_url,
                "pdf_text": [],
                "error": str(e)
            })

    return results

@tool("retrieve_arxiv_articles_summaries", args_schema=RetrieveArxivArticlesSummariesInput)
def retrieve_arxiv_articles_summaries(query: str) -> list:
    """
    Retrieve academic papers summaries from ArXiv based on a search query.

    Parameters:
        query (str): The search string to query ArXiv (e.g., keywords or title).

    Returns:
        list: A list of article summaries in string format
    """
    # Initialize the ArXiv Api Wrapper and get the summaries
    arxiv = ArxivAPIWrapper()
    docs = arxiv.run(query)

    # Format the summaries and return them
    chunks = docs.split("Published: ")
    papers = ["Published: " + chunk.strip() for chunk in chunks if chunk.strip()]
    return papers

@tool("get_stock_market_news", args_schema=GetStockMarketNewsInput)
def get_stock_market_news(stock: str) -> str:
    """
    Fetches stock market news sentiment data for a given stock.

    Args:
        stock (str): The stock ticker symbol (e.g., 'AAPL').

    Returns:
        str: News sentiment analysis for the stock.
    """
    try:
        alpha_vantage = AlphaVantageAPIWrapper()
        result = alpha_vantage._get_market_news_sentiment(stock)
        return f"Market news sentiment for {stock}:\n{result}"
    except Exception as e:
        return f"Error retrieving stock market news data: {str(e)}"

@tool("get_top_gainers_losers_stock_data", args_schema=GetTopGainersLosersStockDataInput)
def get_top_gainers_losers_stock_data() -> str:
    """
    Fetches the top gainers and losers in the stock market.

    Returns:
        str: List of top gainers and losers.
    """
    try:
        alpha_vantage = AlphaVantageAPIWrapper()
        result = alpha_vantage._get_top_gainers_losers()
        return f"Top gainers and losers:\n{result}"
    except Exception as e:
        return f"Error retrieving top gainers and losers data: {str(e)}"

@tool("get_weekly_stock_data", args_schema=GetWeeklyStockDataInput)
def get_weekly_stock_data(stock: str) -> str:
    """
    Fetches weekly historical stock data for a given stock.

    Args:
        stock (str): The stock ticker symbol (e.g., 'AAPL').

    Returns:
        str: Weekly historical stock data.
    """
    try:
        alpha_vantage = AlphaVantageAPIWrapper()
        result = alpha_vantage._get_time_series_weekly(stock)
        return f"Weekly historical stock data for {stock}:\n{result}"
    except Exception as e:
        return f"Error retrieving weekly historical stock data: {str(e)}"

@tool("get_daily_stock_data", args_schema=GetDailyStockDataInput)
def get_daily_stock_data(stock: str) -> str:
    """
    Fetches daily historical stock data for a given stock.

    Args:
        stock (str): The stock ticker symbol (e.g., 'AAPL').

    Returns:
        str: Historical stock data.
    """
    try:
        alpha_vantage = AlphaVantageAPIWrapper()
        result = alpha_vantage._get_time_series_daily(stock)
        return f"Daily historical stock data for {stock}:\n{result}"
    except Exception as e:
        return f"Error retrieving daily historical stock data: {str(e)}"

@tool("get_current_stock_data", args_schema=GetCurrentStockDataInput)
def get_current_stock_data(stock: str, currency: str) -> str:
    """
    Fetches the latest exchange rate for a given stock and currency.

    Args:
        stock (str): The stock ticker symbol (e.g., 'AAPL').
        currency (str): The currency to convert to (e.g., 'USD').

    Returns:
        str: The exchange rate data.
    """
    try:
        alpha_vantage = AlphaVantageAPIWrapper()
        result = alpha_vantage._get_exchange_rate(currency, stock)
        return f"Current stock data for {stock} in {currency}: {result}"
    except Exception as e:
        return f"Error retrieving current stock data: {str(e)}"

@tool("executes_python_code", args_schema=ExecutesPythonCodeInput)
def executes_python_code(code: str, libraries: List[str] = []) -> str:
    """
    Executes a Python code snippet inside the CrewAI CodeInterpreterTool environment.

    This function allows running arbitrary Python code and optionally installs 
    libraries inside a secure containerized interpreter environment provided by CrewAI.

    Args:
        code (str): The Python code to execute.
        libraries (List[str]): A list of Python libraries to install before execution (e.g., ['pandas', 'numpy']).

    Returns:
        str: The output or result of the executed code, or an error message if execution fails.
    """
    # Dedent the code to prevent indentation errors
    clean_code = textwrap.dedent(code)

    # Initialize the interpreter tool
    code_exec = CodeInterpreterTool()

    # Run the code
    try:
        result = code_exec.run(code=clean_code, libraries_used=libraries)
    except Exception as e:
        result = f"Execution failed with error: {e}"

    return result

dalle_tool = OpenAIDALLEImageGenerationTool(api_wrapper=DallEAPIWrapper(model='dall-e-3',
                                                                        size="1024x1024"),
                                            args_schema=ImageGenerationInput)




