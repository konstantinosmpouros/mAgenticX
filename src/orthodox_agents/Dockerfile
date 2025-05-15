# 1. Base image
FROM python:3.10-slim

# 2. Set environment variables to ensure Python runs optimally
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 3. Set the working directory
WORKDIR /app

# 4. Install system deps (if you need build tools for any packages)
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# 5. Copy & install Python dependencies
COPY ./requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 6. Copy the agent code
COPY . /app

# Expose the necessary port (default for FastAPI)
EXPOSE 8081

# Command to run the FastAPI server
CMD ["uvicorn", "__init__:app", "--host", "0.0.0.0", "--port", "8081", "--reload"]


