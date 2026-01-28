# Voice Notes Bot Dockerfile
# This version uses external Whisper API (docker-compose.yml includes whisper service)
FROM python:3.11-slim

# Install system dependencies for audio processing
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install dependencies (sentence-transformers needs build tools)
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the embedding model to speed up first run
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('intfloat/multilingual-e5-small')" || true

# Copy application code
COPY . .

# Create data directory for vector DB and tokens
RUN mkdir -p /app/data/vectordb

# Expose port for extension API
EXPOSE 3000

# Run the bot
CMD ["python", "run.py"]

