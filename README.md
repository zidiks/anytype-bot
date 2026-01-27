# 🎤 Anytype Voice Notes Bot

Telegram bot that transcribes voice messages, generates AI summaries, and saves everything to Anytype.

## Features

- 🎤 **Voice Transcription** — Self-hosted speech-to-text using Whisper
- 🤖 **AI Summarization** — Generates concise summaries via DeepSeek API
- 💾 **Anytype Integration** — Saves notes with summary + full transcription
- 👤 **Multi-user** — Shows Telegram username in note titles
- 🚀 **CI/CD** — Automatic deployment via GitHub Actions

## Architecture

```
Voice Message → Telegram Bot → Whisper (transcription) → DeepSeek (summary) → Anytype (storage)
```

## Quick Start

### 1. Clone and Configure

```bash
git clone <repo>
cd anytype-bot

# Copy environment template
cp env.example .env

# Edit .env with your credentials
```

### 2. Configure Environment

Edit `.env` file:

```env
# Telegram Bot (get from @BotFather)
TELEGRAM_BOT_TOKEN=your_token

# Anytype API
ANYTYPE_API_URL=http://89.40.5.115:31012
ANYTYPE_BEARER_TOKEN=your_anytype_token
ANYTYPE_SPACE_ID=your_space_id
ANYTYPE_NOTES_OBJECT_ID=your_notes_collection_id

# DeepSeek API
DEEPSEEK_API_KEY=your_deepseek_key

# Whisper (local or api)
WHISPER_MODE=local
WHISPER_MODEL=base

# Optional: Restrict to specific users
ALLOWED_USER_IDS=123456789,987654321
```

### 3. Run with Docker (Recommended)

**Option A: With separate Whisper container (recommended for production)**

```bash
docker-compose up -d
```

This starts:
- `anytype-voice-bot` — The Telegram bot
- `anytype-whisper` — Self-hosted Whisper ASR on port 9000

**Option B: With local Whisper (single container)**

```bash
docker-compose -f docker-compose.local.yml up -d
```

### 4. Run Locally (Development)

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows

# Install dependencies
pip install -r requirements.txt

# Install ffmpeg (required for audio processing)
# Ubuntu: sudo apt install ffmpeg
# macOS: brew install ffmpeg
# Windows: choco install ffmpeg

# Run
python run.py
```

## Usage

1. Start a chat with your bot on Telegram
2. Send `/start` to see the welcome message
3. Record and send a voice message
4. Bot will:
   - Download and transcribe the audio
   - Generate an AI summary
   - Create a new note in Anytype
   - Add a reference to your notes collection

## Anytype Note Structure

Each voice note is saved as:

```markdown
## Summary
[AI-generated summary]

---

## Full Transcription
> [Complete transcribed text as a quote block]
```

The note is automatically linked to your main notes collection (Volodya's Notes).

## Self-Hosted Whisper Options

### Option 1: Integrated faster-whisper (Default)

Runs inside the bot container. Good for:
- Single-server deployments
- Lower resource environments

```env
WHISPER_MODE=local
WHISPER_MODEL=base  # tiny, base, small, medium, large-v3
```

### Option 2: Separate Whisper Service

Uses [openai-whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice). Good for:
- Multiple bots sharing one Whisper instance
- GPU-accelerated transcription
- Scaling independently

```env
WHISPER_MODE=api
WHISPER_API_URL=http://whisper:9000
```

### Model Size Comparison

| Model | Size | RAM | Speed | Accuracy |
|-------|------|-----|-------|----------|
| tiny | 39M | ~1GB | Fastest | Basic |
| base | 74M | ~1GB | Fast | Good |
| small | 244M | ~2GB | Medium | Better |
| medium | 769M | ~5GB | Slow | Great |
| large-v3 | 1.5GB | ~10GB | Slowest | Best |

## Project Structure

```
anytype-bot/
├── src/
│   ├── __init__.py
│   ├── bot.py           # Main Telegram bot
│   ├── config.py        # Configuration loader
│   ├── anytype_client.py # Anytype API client
│   ├── transcription.py  # Whisper transcription
│   └── summarizer.py     # DeepSeek summarization
├── run.py               # Entry point
├── requirements.txt
├── Dockerfile
├── Dockerfile.local
├── docker-compose.yml          # Local development
├── docker-compose.prod.yml     # Production (pulls from GHCR)
├── docker-compose.local.yml
└── env.example
```

## CI/CD & Production Deployment

### GitHub Actions

The project includes automatic CI/CD via GitHub Actions (`.github/workflows/deploy.yml`):

1. **Build** — Builds Docker image on push to `main`
2. **Push** — Pushes to GitHub Container Registry (ghcr.io)
3. **Deploy** — SSHs to server and deploys with docker-compose

### Required GitHub Secrets

Configure these in your repository Settings → Secrets:

| Secret | Description |
|--------|-------------|
| `SERVER_HOST` | Server IP address |
| `SERVER_PORT` | SSH port (usually 22) |
| `SERVER_USERNAME` | SSH username |
| `SERVER_PASSWORD` | SSH password |
| `DEPLOY_PATH` | Path to project on server (e.g., `/root/anytype-bot`) |

> Note: `GITHUB_TOKEN` is provided automatically by GitHub Actions.

### Server Setup

1. **Clone repository on server:**
```bash
cd /root
git clone https://github.com/YOUR_USERNAME/anytype-bot.git
cd anytype-bot
```

2. **Create `.env` file:**
```bash
cp env.example .env
nano .env  # Edit with your credentials
```

3. **First deploy (manual):**
```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

4. **Subsequent deploys** happen automatically when you push to `main`.

### Production Docker Compose

Use `docker-compose.prod.yml` for production — it pulls pre-built images from GitHub Container Registry:

```bash
docker compose -f docker-compose.prod.yml up -d
```

## API Reference

### Anytype API

Based on [Anytype Developer Documentation](https://developers.anytype.io/docs/reference):

- `POST /spaces/{space_id}/objects` — Create new object
- `GET /spaces/{space_id}/objects/{object_id}` — Get object
- `PATCH /spaces/{space_id}/objects/{object_id}` — Update object
- `GET /spaces/{space_id}/types` — List available types

### DeepSeek API

OpenAI-compatible API at `https://api.deepseek.com/v1`:

- `POST /chat/completions` — Generate summary

## Troubleshooting

### "Could not transcribe the audio"

- Ensure ffmpeg is installed
- Check that the voice message has clear audio
- Try a larger Whisper model

### Anytype API errors

- Verify your bearer token is correct
- Check that the space ID and object IDs exist
- Ensure your Anytype server is accessible

### DeepSeek API errors

- Verify your API key is valid
- Check your API quota/limits

## License

MIT
