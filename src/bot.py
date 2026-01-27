"""
Telegram bot for voice note transcription and storage in Anytype.
"""

import os
import tempfile
import logging
from datetime import datetime
from pathlib import Path

from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command
from aiogram.types import Message

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
        
        # Register handlers
        self._register_handlers()
    
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
    
    def _register_handlers(self):
        """Register message handlers."""
        
        @self.dp.message(Command("start"))
        async def cmd_start(message: Message):
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            await message.answer(
                "👋 **Welcome to Voice Notes Bot!**\n\n"
                "Send me a voice message and I will:\n"
                "1. 🎤 Transcribe it to text\n"
                "2. 📝 Create a summary using AI\n"
                "3. 💾 Save it to your Anytype space\n\n"
                "Just record and send a voice message to get started!",
                parse_mode="Markdown",
            )
        
        @self.dp.message(Command("help"))
        async def cmd_help(message: Message):
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            await message.answer(
                "📖 **Voice Notes Bot Help**\n\n"
                "**Commands:**\n"
                "/start - Start the bot\n"
                "/help - Show this help message\n"
                "/status - Check service status\n\n"
                "**Usage:**\n"
                "Simply send a voice message and the bot will automatically:\n"
                "• Transcribe your speech to text\n"
                "• Generate an AI summary\n"
                "• Save both to Anytype\n\n"
                "**Note:** Processing may take a moment depending on the length of your message.",
                parse_mode="Markdown",
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
            
            await message.answer("\n".join(status_lines), parse_mode="Markdown")
        
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
            """Handle text messages - remind about voice."""
            if not self._is_user_allowed(message.from_user.id):
                await message.answer("⛔ You are not authorized to use this bot.")
                return
            
            await message.answer(
                "💡 This bot is designed for voice messages.\n\n"
                "Please **record and send a voice message** to create a note.\n"
                "Use /help for more information.",
                parse_mode="Markdown",
            )
    
    async def start(self):
        """Start the bot."""
        logger.info("Starting Voice Notes Bot...")
        
        # Initialize Anytype client
        await self.init_anytype()
        
        # Start polling
        await self.dp.start_polling(self.bot)
    
    async def stop(self):
        """Stop the bot and cleanup."""
        logger.info("Stopping Voice Notes Bot...")
        
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

