# 1. Base image
FROM python:3.12-slim

# 2. Set environment variables to ensure Python runs optimally
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 3. Install requirements and set working directory
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copy source
COPY . .

# The release tag, passed in by CD (`--build-arg APP_VERSION=v1.4.3`), so a
# running container can always be traced back to the release it came from.
# Declared last so changing it never invalidates the dependency layers above.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Expose the needed port and run
EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
