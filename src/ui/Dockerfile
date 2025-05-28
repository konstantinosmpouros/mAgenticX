# 1. Base image
FROM python:3.10-slim

# 2. Set environment variables to ensure Python runs optimally
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 3. Install requirements and set working directory
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Install system deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# 5. Copy source
COPY . .

# Expose the needed port and run
EXPOSE 8501
CMD [ "streamlit", "run", "app.py" ]