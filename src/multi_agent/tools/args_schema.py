from typing import List
from pydantic import BaseModel, Field


class SearchWikidataInput(BaseModel):
    query: str = Field(..., description="The search term to look up in Wikidata.")


class SearchWikipediaInput(BaseModel):
    query: str = Field(..., description="The search term to look up in Wikipedia.")


class SearchGoogleTrendsInput(BaseModel):
    keywords: List[str] = Field(
        ..., description="List of keywords to search on Google Trends."
    )
    timeframe: str = Field("today 12-m", description="Timeframe for the trends data.")


class SearchPubmedInput(BaseModel):
    query: str = Field(..., description="The search term to look up in PubMed.")


class RetrieveArxivArticlesContentInput(BaseModel):
    query: str = Field(
        ...,
        description="The search query string to retrieve relevant papers content from ArXiv.",
    )


class RetrieveArxivArticlesSummariesInput(BaseModel):
    query: str = Field(..., description="The search string to query ArXiv.")


class GetStockMarketNewsInput(BaseModel):
    stock: str = Field(..., description="The stock ticker symbol (e.g., 'AAPL').")


class GetTopGainersLosersStockDataInput(BaseModel):
    pass


class GetWeeklyStockDataInput(BaseModel):
    stock: str = Field(..., description="The stock ticker symbol (e.g., 'AAPL').")


class GetDailyStockDataInput(BaseModel):
    stock: str = Field(..., description="The stock ticker symbol (e.g., 'AAPL').")


class GetCurrentStockDataInput(BaseModel):
    stock: str = Field(..., description="The stock ticker symbol (e.g., 'AAPL').")
    currency: str = Field(..., description="The currency to convert to (e.g., 'USD').")


class ExecutesPythonCodeInput(BaseModel):
    code: str = Field(..., description="The Python code to execute.")
    libraries: List[str] = Field(
        default_factory=list,
        description="A list of Python libraries to install before execution.",
    )


class ImageGenerationInput(BaseModel):
    description: str = Field(..., description="A prompt that describes the image and will be passed to the Image Gen Model")


