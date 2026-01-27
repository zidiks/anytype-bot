"""
Telegram bot for voice note transcription and storage in Anytype.
Also provides API for Chrome extension.
"""

import os
import tempfile
import logging
import asyncio
import json
from datetime import datetime
from pathlib import Path

from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command
from aiogram.types import Message, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiohttp import web

from .config import Config, load_config
from .anytype_client import AnytypeClient, create_anytype_client
from .transcription import (
    create_transcription_service, 
    convert_ogg_to_wav,
    TranscriptionService,
)
from .summarizer import create_summarizer, DeepSeekSummarizer

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


class VoiceNotesBot:
    """Main bot class for handling voice messages."""
    
    TOKENS_FILE = Path("data/extension_tokens.json")
    
    def __init__(self, config: Config):
        self.config = config
        self.bot = Bot(token=config.telegram_bot_token)
        self.dp = Dispatcher()
        
        # Initialize services
        self.transcription: TranscriptionService = create_transcription_service(
            mode=config.whisper_mode,
            model=config.whisper_model,
            api_url=config.whisper_api_url,
        )
        
        self.summarizer: DeepSeekSummarizer = create_summarizer(
            api_key=config.deepseek_api_key,
            api_url=config.deepseek_api_url,
        )
        
        self.anytype: AnytypeClient | None = None
        
        # Extension tokens - maps token to user_id (persisted to disk)
        self.extension_tokens: dict[str, int] = self._load_tokens()
        
        # Web app for extension API
        self.web_app = web.Application()
        self.web_runner = None
        self._setup_web_routes()
        
        # Register handlers
        self._register_handlers()
    
    def _load_tokens(self) -> dict[str, int]:
        """Load extension tokens from disk."""
        try:
            if self.TOKENS_FILE.exists():
                with open(self.TOKENS_FILE, 'r') as f:
                    data = json.load(f)
                    logger.info(f"Loaded {len(data)} extension tokens from disk")
                    return data
        except Exception as e:
            logger.warning(f"Failed to load tokens: {e}")
        return {}
    
    def _save_tokens(self):
        """Save extension tokens to disk."""
        try:
            self.TOKENS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(self.TOKENS_FILE, 'w') as f:
                json.dump(self.extension_tokens, f)
            logger.debug(f"Saved {len(self.extension_tokens)} extension tokens to disk")
        except Exception as e:
            logger.error(f"Failed to save tokens: {e}")
    
    def _setup_web_routes(self):
        """Setup web API routes for extension."""
        self.web_app.router.add_get('/health', self._web_health)
        self.web_app.router.add_get('/api/extension/config/{token}', self._web_get_config)
        self.web_app.router.add_get('/connect/{token}', self._web_connect_page)
        self.web_app.router.add_post('/api/extension/event', self._web_log_event)
        self.web_app.router.add_post('/api/extension/save', self._web_save_transcript)
        self.web_app.router.add_post('/api/extension/summarize-chunk', self._web_summarize_chunk)
        
        # Enable CORS
        async def cors_middleware(app, handler):
            async def middleware_handler(request):
                if request.method == 'OPTIONS':
                    response = web.Response()
                else:
                    try:
                        response = await handler(request)
                    except web.HTTPException as ex:
                        response = ex
                response.headers['Access-Control-Allow-Origin'] = '*'
                response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
                response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
                return response
            return middleware_handler
        
        self.web_app.middlewares.append(cors_middleware)
    
    async def _web_health(self, request):
        """Health check endpoint."""
        return web.json_response({"status": "ok"})
    
    async def _web_connect_page(self, request):
        """Serve the extension auto-connect page."""
        token = request.match_info['token']
        
        user_id = self.extension_tokens.get(token)
        if not user_id:
            return web.Response(
                text="<html><body><h1>❌ Invalid or expired link</h1><p>Please get a new link from the Telegram bot.</p></body></html>",
                content_type="text/html"
            )
        
        # Get the server URL for API calls
        bot_url = os.getenv('BOT_PUBLIC_URL', request.url.origin)
        
        # Serve a page that the extension will detect and auto-connect
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Anytype Meet Recorder - Connect</title>
    <meta name="extension-token" content="{token}">
    <meta name="server-url" content="{bot_url}">
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
        }}
        .container {{
            text-align: center;
            padding: 40px;
            background: rgba(255,255,255,0.05);
            border-radius: 20px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
            max-width: 500px;
        }}
        .logo {{ font-size: 64px; margin-bottom: 20px; }}
        h1 {{ font-size: 24px; margin-bottom: 10px; }}
        .status {{ 
            padding: 15px 30px; 
            border-radius: 10px; 
            margin: 20px 0;
            font-size: 18px;
        }}
        .waiting {{ background: rgba(255,193,7,0.2); border: 1px solid #ffc107; }}
        .success {{ background: rgba(76,175,80,0.2); border: 1px solid #4caf50; }}
        .error {{ background: rgba(244,67,54,0.2); border: 1px solid #f44336; }}
        .spinner {{
            width: 40px; height: 40px;
            border: 3px solid rgba(255,255,255,0.3);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 20px auto;
        }}
        @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
        .instructions {{ 
            color: rgba(255,255,255,0.7); 
            line-height: 1.6;
            margin-top: 20px;
        }}
        .manual-link {{
            margin-top: 20px;
            padding: 10px;
            background: rgba(0,0,0,0.3);
            border-radius: 8px;
            word-break: break-all;
            font-family: monospace;
            font-size: 12px;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">🔌</div>
        <h1>Anytype Meet Recorder</h1>
        <div id="status" class="status waiting">
            <div class="spinner"></div>
            Ожидание расширения...
        </div>
        <p class="instructions" id="instructions">
            Откройте эту страницу в браузере, где установлено расширение.<br>
            Оно автоматически подключится.
        </p>
        <div class="manual-link" id="manual" style="display:none;">
            <strong>Или скопируйте ссылку в настройки расширения:</strong><br>
            {bot_url}/api/extension/config/{token}
        </div>
    </div>
    <script>
        const token = "{token}";
        const serverUrl = "{bot_url}";
        
        // Notify extension that we're ready to connect
        window.postMessage({{
            type: 'ANYTYPE_EXTENSION_CONNECT',
            token: token,
            serverUrl: serverUrl
        }}, '*');
        
        // Listen for extension response
        window.addEventListener('message', (event) => {{
            if (event.data.type === 'ANYTYPE_EXTENSION_CONNECTED') {{
                document.getElementById('status').className = 'status success';
                document.getElementById('status').innerHTML = '✅ Подключено!';
                document.getElementById('instructions').textContent = 
                    'Расширение подключено. Можете закрыть эту страницу и начать запись в Google Meet!';
            }}
        }});
        
        // Show manual link after 5 seconds if no response
        setTimeout(() => {{
            if (!document.getElementById('status').classList.contains('success')) {{
                document.getElementById('manual').style.display = 'block';
                document.getElementById('instructions').innerHTML = 
                    'Расширение не обнаружено.<br>Убедитесь что оно установлено и страница открыта в том же браузере.';
            }}
        }}, 5000);
    </script>
</body>
</html>"""
        
        return web.Response(text=html, content_type="text/html")
    
    async def _web_get_config(self, request):
        """Get extension config by token."""
        token = request.match_info['token']
        
        user_id = self.extension_tokens.get(token)
        if not user_id:
            return web.json_response({"error": "Invalid token"}, status=401)
        
        # Return config for extension
        return web.json_response({
            "anytypeApiUrl": self.config.anytype_api_url,
            "anytypeBearerToken": self.config.anytype_bearer_token,
            "anytypeSpaceId": self.config.anytype_space_id,
            "deepseekApiKey": self.config.deepseek_api_key,
            "deepseekApiUrl": self.config.deepseek_api_url,
        })
    
    async def _web_log_event(self, request):
        """Log event from extension to Telegram."""
        try:
            data = await request.json()
            token = data.get('token')
            event = data.get('event')
            message = data.get('message')
            
            user_id = self.extension_tokens.get(token)
            if not user_id:
                return web.json_response({"error": "Invalid token"}, status=401)
            
            # Send notification to user
            if event == 'recording_started':
                await self.bot.send_message(
                    user_id,
                    f"🎥 Recording started\n📹 {message}"
                )
            elif event == 'recording_stopped':
                await self.bot.send_message(
                    user_id,
                    f"⏹️ Recording stopped\n📝 Processing..."
                )
            elif event == 'intermediate_summary':
                # Brief notification for intermediate summaries
                await self.bot.send_message(
                    user_id,
                    f"📊 {message}"
                )
            elif event == 'saved':
                await self.bot.send_message(
                    user_id,
                    f"✅ Meeting saved to Anytype!\n📋 {message}"
                )
            elif event == 'error':
                await self.bot.send_message(
                    user_id,
                    f"❌ Extension error:\n{message}"
                )
            
            return web.json_response({"success": True})
            
        except Exception as e:
            logger.error(f"Event logging error: {e}")
            return web.json_response({"error": str(e)}, status=500)
    
    async def _web_summarize_chunk(self, request):
        """Generate intermediate summary for a chunk of meeting text."""
        try:
            data = await request.json()
            token = data.get('token')
            
            user_id = self.extension_tokens.get(token)
            if not user_id:
                return web.json_response({"error": "Invalid token"}, status=401)
            
            chunk_number = data.get('chunkNumber', 1)
            text = data.get('text', '')
            meeting_title = data.get('meetingTitle', 'Google Meet')
            
            if len(text) < 50:
                return web.json_response({"error": "Text too short for summary"}, status=400)
            
            logger.info(f"Generating intermediate summary #{chunk_number} ({len(text)} chars)")
            
            # Generate summary for this chunk
            summary = await self.summarizer.summarize_chunk(text, chunk_number, meeting_title)
            
            logger.info(f"Intermediate summary #{chunk_number}: {len(summary)} chars")
            
            return web.json_response({
                "success": True,
                "summary": summary,
                "chunkNumber": chunk_number
            })
            
        except Exception as e:
            logger.error(f"Summarize chunk error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)
    
    async def _web_save_transcript(self, request):
        """Save transcript from extension."""
        try:
            data = await request.json()
            token = data.get('token')
            
            user_id = self.extension_tokens.get(token)
            if not user_id:
                return web.json_response({"error": "Invalid token"}, status=401)
            
            meeting_title = data.get('meetingTitle', 'Google Meet Recording')
            transcript = data.get('transcript', '')
            duration = data.get('duration', 0)
            intermediate_summaries = data.get('intermediateSummaries', [])
            
            logger.info(f"Received transcript: {len(transcript)} chars, duration: {duration} min, chunks: {len(intermediate_summaries)}")
            
            if len(transcript) < 10:
                # Notify user about the problem
                await self.bot.send_message(
                    user_id,
                    f"⚠️ Transcript too short ({len(transcript)} chars)\n\n"
                    "Make sure:\n"
                    "1. Captions are ON (press C in Meet)\n"
                    "2. Someone was speaking during recording\n"
                    "3. Language is set correctly in Meet settings"
                )
                return web.json_response({"error": f"Transcript too short ({len(transcript)} chars). Enable captions in Meet."}, status=400)
            
            # Generate final summary
            if intermediate_summaries and len(intermediate_summaries) > 0:
                # Combine intermediate summaries for long meetings
                logger.info(f"Combining {len(intermediate_summaries)} intermediate summaries...")
                summary = await self.summarizer.combine_summaries(intermediate_summaries, meeting_title)
            else:
                # Direct summary for short meetings
                logger.info(f"Generating summary for {len(transcript)} chars...")
                summary = await self.summarizer.summarize(transcript)
            
            # Save to Anytype
            if not self.anytype:
                await self.init_anytype()
            
            # Get username from stored mapping if available
            username = f"user_{user_id}"
            
            # Format body with timeline if we have multiple chunks
            body = f"## Summary\n\n{summary}\n\n---\n\n"
            
            if intermediate_summaries and len(intermediate_summaries) > 1:
                body += "## Meeting Timeline\n\n"
                for chunk in intermediate_summaries:
                    chunk_num = chunk.get('chunkNumber', '?')
                    chunk_summary = chunk.get('summary', '')
                    body += f"### Part {chunk_num}\n{chunk_summary}\n\n"
                body += "---\n\n"
            
            body += f"## Full Transcript\n\n> {transcript}\n\n---\n*Duration: {duration} minutes*\n"
            
            # Create object
            date_str = datetime.now().strftime('%Y-%m-%d %H:%M')
            title = f"🎥 {meeting_title} - {date_str}"
            
            result = await self.anytype.create_object(
                name=title,
                body=body,
                icon_emoji="🎥"
            )
            
            logger.info(f"Saved meeting note: {result.object_id}")
            
            # Notify user
            summary_preview = summary[:300] + "..." if len(summary) > 300 else summary
            chunks_info = f"\n📊 Chunks: {len(intermediate_summaries)}" if intermediate_summaries else ""
            
            await self.bot.send_message(
                user_id,
                f"✅ Meeting saved to Anytype!\n\n"
                f"📹 {meeting_title}\n"
                f"⏱️ Duration: {duration} min{chunks_info}\n\n"
                f"📝 Summary:\n{summary_preview}"
            )
            
            return web.json_response({
                "success": True,
                "objectId": result.object_id,
                "summary": summary
            })
            
        except Exception as e:
            logger.error(f"Save transcript error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)
    
    async def init_anytype(self):
        """Initialize Anytype client."""
        self.anytype = await create_anytype_client(
            api_url=self.config.anytype_api_url,
            bearer_token=self.config.anytype_bearer_token,
            space_id=self.config.anytype_space_id,
        )
    
    def _is_user_allowed(self, user_id: int) -> bool:
        """Check if user is allowed to use the bot."""
        if not self.config.allowed_user_ids:
            return True  # Allow all if no restrictions
        return user_id in self.config.allowed_user_ids
    
    def _generate_extension_token(self, user_id: int) -> str:
        """Generate a token for extension authentication."""
        import secrets
        token = secrets.token_urlsafe(32)
        self.extension_tokens[token] = user_id
        self._save_tokens()  # Persist to disk
        return token
    
    def _get_main_keyboard(self) -> ReplyKeyboardMarkup:
        """Get the main reply keyboard menu."""
        keyboard = ReplyKeyboardMarkup(
            keyboard=[
                [
                    KeyboardButton(text="🎤 Записать голосовое"),
                    KeyboardButton(text="🔌 Подключить расширение"),
                ],
                [
                    KeyboardButton(text="📊 Статус"),
                    KeyboardButton(text="❓ Помощь"),
                ],
            ],
            resize_keyboard=True,
            input_field_placeholder="Отправьте голосовое сообщение..."
        )
        return keyboard
    
    def _register_handlers(self):
        """Register message handlers."""
        
        @self.dp.message(Command("start"))
        async def cmd_start(message: Message):
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            await message.answer(
                "👋 *Добро пожаловать в Voice Notes Bot!*\n\n"
                "Отправь мне голосовое сообщение и я:\n"
                "1. 🎤 Транскрибирую его в текст\n"
                "2. 📝 Создам краткое содержание через AI\n"
                "3. 💾 Сохраню всё в твой Anytype\n\n"
                "📹 *Google Meet:*\n"
                "Нажми «🔌 Подключить расширение» для записи митингов\n\n"
                "Просто запиши голосовое чтобы начать!",
                parse_mode="Markdown",
                reply_markup=self._get_main_keyboard(),
            )
        
        @self.dp.message(Command("help"))
        async def cmd_help(message: Message):
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            await message.answer(
                "📖 *Справка Voice Notes Bot*\n\n"
                "*Голосовые заметки:*\n"
                "Просто отправь голосовое сообщение и бот:\n"
                "• Транскрибирует речь в текст\n"
                "• Создаст AI саммари\n"
                "• Сохранит всё в Anytype\n\n"
                "*Запись Google Meet:*\n"
                "1. Нажми «🔌 Подключить расширение»\n"
                "2. Установи расширение в Chrome\n"
                "3. Нажми кнопку подключения\n"
                "4. Открой Google Meet и нажми Record!\n\n"
                "*Для длинных митингов (>10 мин):*\n"
                "Бот автоматически создаёт промежуточные саммари\n"
                "каждые 10 минут для надёжности.",
                parse_mode="Markdown",
                reply_markup=self._get_main_keyboard(),
            )
        
        @self.dp.message(Command("extension"))
        async def cmd_extension(message: Message):
            """Setup Chrome extension."""
            await self._send_extension_setup(message)
        
        async def _send_extension_setup(message: Message):
            """Send extension setup message with inline button."""
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            user_id = message.from_user.id
            token = self._generate_extension_token(user_id)
            
            # Get the bot's public URL
            bot_url = os.getenv('BOT_PUBLIC_URL', 'http://YOUR_SERVER_IP:3000')
            
            connect_url = f"{bot_url}/connect/{token}"
            
            # Create inline keyboard with connect button
            inline_kb = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="🔌 Подключить расширение", url=connect_url)],
                [InlineKeyboardButton(text="📥 Скачать расширение", url="https://github.com/user/anytype-bot/releases")]
            ])
            
            await message.answer(
                "🔌 *Настройка Chrome расширения*\n\n"
                "*Шаг 1:* Установи расширение\n"
                "Скачай папку `chrome-extension` и загрузи в Chrome:\n"
                "`chrome://extensions` → Режим разработчика → Загрузить\n\n"
                "*Шаг 2:* Подключи расширение\n"
                "Нажми кнопку ниже (откроется страница подключения)\n\n"
                "*Шаг 3:* Записывай митинги!\n"
                "Открой Google Meet и нажми кнопку Record\n\n"
                "⚠️ Ссылка персональная — не делись ею!",
                parse_mode="Markdown",
                reply_markup=inline_kb,
            )
        
        @self.dp.message(Command("status"))
        async def cmd_status(message: Message):
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            status_lines = ["📊 **Service Status**\n"]
            
            # Check Anytype connection
            try:
                if self.anytype:
                    await self.anytype.get_object(self.config.anytype_notes_object_id)
                    status_lines.append("✅ Anytype API: Connected")
                else:
                    status_lines.append("⚠️ Anytype API: Not initialized")
            except Exception as e:
                status_lines.append(f"❌ Anytype API: {str(e)[:50]}")
            
            # Transcription mode
            status_lines.append(f"🎤 Transcription: {self.config.whisper_mode} mode")
            if self.config.whisper_mode == "local":
                status_lines.append(f"   Model: {self.config.whisper_model}")
            
            # DeepSeek
            status_lines.append("✅ DeepSeek API: Configured")
            
            # Extension API
            status_lines.append("✅ Extension API: Running on port 3000")
            
            await message.answer(
                "\n".join(status_lines), 
                parse_mode="Markdown",
                reply_markup=self._get_main_keyboard(),
            )
        
        @self.dp.message(F.voice)
        async def handle_voice(message: Message):
            """Handle voice messages."""
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            user_id = message.from_user.id
            logger.info(f"Received voice message from user {user_id}")
            
            # Send processing status
            status_msg = await message.answer("🎤 Processing your voice message...")
            
            temp_dir = tempfile.mkdtemp()
            ogg_path = os.path.join(temp_dir, f"voice_{message.message_id}.ogg")
            
            try:
                # Download voice file
                await status_msg.edit_text("📥 Downloading audio...")
                file = await self.bot.get_file(message.voice.file_id)
                await self.bot.download_file(file.file_path, ogg_path)
                
                # Convert to WAV (better compatibility)
                await status_msg.edit_text("🔄 Converting audio format...")
                wav_path = await convert_ogg_to_wav(ogg_path)
                
                # Transcribe
                await status_msg.edit_text("🎤 Transcribing speech to text...")
                full_text = await self.transcription.transcribe(wav_path)
                
                if not full_text.strip():
                    await status_msg.edit_text("⚠️ Could not transcribe the audio. Please try again with clearer speech.")
                    return
                
                logger.info(f"Transcribed {len(full_text)} characters")
                
                # Summarize
                await status_msg.edit_text("🤖 Generating AI summary...")
                summary = await self.summarizer.summarize(full_text)
                
                logger.info(f"Generated summary: {len(summary)} characters")
                
                # Save to Anytype
                await status_msg.edit_text("💾 Saving to Anytype...")
                
                if not self.anytype:
                    await self.init_anytype()
                
                # Get username for the note title
                user = message.from_user
                username = user.username or user.first_name or f"user_{user.id}"
                
                # Create the voice note object
                created_object = await self.anytype.create_voice_note(
                    summary=summary,
                    full_text=full_text,
                    timestamp=datetime.now(),
                    username=username,
                )
                
                logger.info(f"Created Anytype object: {created_object.object_id}")
                
                # Send success message with preview (no Markdown to avoid parsing issues)
                preview_text = full_text[:200] + "..." if len(full_text) > 200 else full_text
                
                await status_msg.edit_text(
                    f"✅ Voice note saved!\n\n"
                    f"📝 Summary:\n{summary}\n\n"
                    f"📄 Full text:\n{preview_text}\n\n"
                    f"🔗 Saved to Anytype",
                )
                
            except Exception as e:
                logger.error(f"Error processing voice message: {e}", exc_info=True)
                # Don't use Markdown for errors - they may contain special chars
                error_text = str(e)[:200]  # Truncate long errors
                await status_msg.edit_text(
                    f"❌ Error processing voice message:\n{error_text}\n\n"
                    "Please try again or contact support.",
                )
            
            finally:
                # Cleanup temp files
                try:
                    for f in Path(temp_dir).glob("*"):
                        f.unlink()
                    Path(temp_dir).rmdir()
                except Exception:
                    pass
        
        @self.dp.message(F.text)
        async def handle_text(message: Message):
            """Handle text messages and keyboard buttons."""
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            text = message.text.strip()
            
            # Handle keyboard buttons
            if text == "🎤 Записать голосовое":
                await message.answer(
                    "🎤 *Запись голосового*\n\n"
                    "Нажми на микрофон 🎙️ в поле ввода сообщения\n"
                    "и запиши свою заметку!\n\n"
                    "Я транскрибирую её, создам саммари и сохраню в Anytype.",
                    parse_mode="Markdown",
                    reply_markup=self._get_main_keyboard(),
                )
            elif text == "🔌 Подключить расширение":
                await _send_extension_setup(message)
            elif text == "📊 Статус":
                await cmd_status(message)
            elif text == "❓ Помощь":
                await cmd_help(message)
            else:
                await message.answer(
                    "💡 Используй кнопки меню внизу или отправь голосовое сообщение!",
                    reply_markup=self._get_main_keyboard(),
                )
    
    async def start(self):
        """Start the bot."""
        logger.info("Starting Voice Notes Bot...")
        
        # Initialize Anytype client
        await self.init_anytype()
        
        # Start web server
        self.web_runner = web.AppRunner(self.web_app)
        await self.web_runner.setup()
        site = web.TCPSite(self.web_runner, '0.0.0.0', 3000)
        await site.start()
        logger.info("Extension API running on port 3000")
        
        # Start polling
        await self.dp.start_polling(self.bot)
    
    async def stop(self):
        """Stop the bot and cleanup."""
        logger.info("Stopping Voice Notes Bot...")
        
        if self.web_runner:
            await self.web_runner.cleanup()
        
        if self.anytype:
            await self.anytype.close()
        
        await self.summarizer.close()
        await self.bot.session.close()


async def main():
    """Main entry point."""
    config = load_config()
    
    # Validate config
    if not config.telegram_bot_token:
        raise ValueError("TELEGRAM_BOT_TOKEN is required")
    if not config.anytype_bearer_token:
        raise ValueError("ANYTYPE_BEARER_TOKEN is required")
    if not config.deepseek_api_key:
        raise ValueError("DEEPSEEK_API_KEY is required")
    
    bot = VoiceNotesBot(config)
    
    try:
        await bot.start()
    finally:
        await bot.stop()


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
