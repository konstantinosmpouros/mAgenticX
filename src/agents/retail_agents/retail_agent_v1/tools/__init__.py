from retail_agents.retail_agent_v1.tools.tools import (
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
    retrieve_arxiv_articles_content,
    retrieve_arxiv_articles_summaries,
)


financial_tools = [
    get_current_exchange_rate,
    get_daily_stock_data,
    get_weekly_stock_data,
    get_stock_market_news,
    get_top_gainers_losers_stock_data,
]

search_tools = [
    search_google_trends,
    search_pubmed,
    search_wikipedia,
    search_wikidata,
]

articles_tools = [
    retrieve_arxiv_articles_content,
    retrieve_arxiv_articles_summaries,
]

computer_vision_tools = [
    image_generation,
]
