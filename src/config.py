import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    # Telegram
    telegram_bot_token: str
    allowed_user_ids: list[int]
    
    # Anytype
    anytype_api_url: str
    anytype_bearer_token: str
    anytype_space_id: str
    anytype_notes_object_id: str
    
    # DeepSeek
    deepseek_api_key: str
    deepseek_api_url: str
    
    # Whisper
    whisper_mode: str  # 'local' or 'api'
    whisper_api_url: str | None
    whisper_model: str


def load_config() -> Config:
    allowed_ids_str = os.getenv("ALLOWED_USER_IDS", "")
    allowed_user_ids = [int(uid.strip()) for uid in allowed_ids_str.split(",") if uid.strip()]
    
    return Config(
        telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", ""),
        allowed_user_ids=allowed_user_ids,
        anytype_api_url=os.getenv("ANYTYPE_API_URL", "http://89.40.5.115:31012"),
        anytype_bearer_token=os.getenv("ANYTYPE_BEARER_TOKEN", ""),
        anytype_space_id=os.getenv("ANYTYPE_SPACE_ID", ""),
        anytype_notes_object_id=os.getenv("ANYTYPE_NOTES_OBJECT_ID", ""),
        deepseek_api_key=os.getenv("DEEPSEEK_API_KEY", ""),
        deepseek_api_url=os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com"),
        whisper_mode=os.getenv("WHISPER_MODE", "local"),
        whisper_api_url=os.getenv("WHISPER_API_URL"),
        whisper_model=os.getenv("WHISPER_MODEL", "base"),
    )








