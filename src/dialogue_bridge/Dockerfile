# Base image
FROM python:3.10-slim

# Enviroment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install system deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Python deps – FastAPI stack + Redis + HTTPX.
RUN pip install --no-cache-dir fastapi fastapi_pagination httpx uvicorn sqlalchemy[asyncio] asyncpg aiosqlite pydantic langchain langchain-openai

WORKDIR /app
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]