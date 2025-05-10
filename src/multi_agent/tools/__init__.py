from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

from tools.tools import (
    get_current_exchange_rate,
    get_daily_stock_data,
    get_stock_market_news,
    get_top_gainers_losers_stock_data,
    get_weekly_stock_data,
    search_google_trends,
    search_pubmed,
    search_wikidata,
    search_wikipedia,
    image_generation,
    executes_python_code,
    retrieve_arxiv_articles_content,
    retrieve_arxiv_articles_summaries,
)


financial_tools = {
    get_current_exchange_rate.name : get_current_exchange_rate,
    get_daily_stock_data.name: get_daily_stock_data,
    get_weekly_stock_data.name: get_weekly_stock_data,
    get_stock_market_news.name: get_stock_market_news,
    get_top_gainers_losers_stock_data.name: get_top_gainers_losers_stock_data,
}

search_tools = {
    search_google_trends.name: search_google_trends,
    search_pubmed.name: search_pubmed,
    search_wikipedia.name: search_wikipedia,
    search_wikidata.name: search_wikidata,
}

articles_tools = {
    retrieve_arxiv_articles_content.name: retrieve_arxiv_articles_content,
    retrieve_arxiv_articles_summaries.name: retrieve_arxiv_articles_summaries,
}

computer_vision_tools = {
    image_generation.name: image_generation,
}

code_tools = {
    executes_python_code.name: executes_python_code,
}
