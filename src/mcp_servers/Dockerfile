# MCP Tools Server container
FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip

RUN mkdir -p /app/mcp_servers

COPY ./requirements.txt /app/mcp_servers/requirements.txt
RUN pip install -r /app/mcp_servers/requirements.txt

COPY . /app/mcp_servers

ENV PYTHONPATH=/app

CMD ["python", "-m", "mcp_servers.tools_server"]
