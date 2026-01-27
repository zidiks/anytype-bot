"""
Speech-to-text transcription service.

Supports:
1. Local faster-whisper (self-hosted, runs on CPU/GPU)
2. External Whisper API (compatible with openai-whisper-asr-webservice)
"""

import os
import tempfile
import aiohttp
import asyncio
from pathlib import Path
from typing import Protocol


class TranscriptionService(Protocol):
    """Protocol for transcription services."""
    
    async def transcribe(self, audio_path: str) -> str:
        """Transcribe audio file to text."""
        ...


class LocalWhisperService:
    """
    Local transcription using faster-whisper.
    
    faster-whisper is a reimplementation of Whisper using CTranslate2,
    which is up to 4x faster than openai-whisper with the same accuracy.
    
    Install: pip install faster-whisper
    """
    
    def __init__(self, model_size: str = "base", device: str = "auto"):
        """
        Initialize local Whisper service.
        
        Args:
            model_size: Model size (tiny, base, small, medium, large-v3)
            device: Device to use (cpu, cuda, or auto)
        """
        self.model_size = model_size
        self.device = device
        self._model = None
        self._available = None
    
    def _check_available(self) -> bool:
        """Check if faster-whisper is available."""
        if self._available is None:
            try:
                import faster_whisper
                self._available = True
            except ImportError:
                self._available = False
        return self._available
    
    def _get_model(self):
        """Lazy load the model."""
        if not self._check_available():
            raise ImportError(
                "faster-whisper is not installed. "
                "Install it with: pip install faster-whisper"
            )
        
        if self._model is None:
            from faster_whisper import WhisperModel
            
            # Determine compute type based on device
            if self.device == "auto":
                try:
                    import torch
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except ImportError:
                    device = "cpu"
            else:
                device = self.device
            
            compute_type = "float16" if device == "cuda" else "int8"
            
            self._model = WhisperModel(
                self.model_size,
                device=device,
                compute_type=compute_type,
            )
        
        return self._model
    
    async def transcribe(self, audio_path: str) -> str:
        """
        Transcribe audio file to text using faster-whisper.
        
        Args:
            audio_path: Path to audio file (supports various formats)
        
        Returns:
            Transcribed text
        """
        # Run in executor to not block event loop
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._transcribe_sync, audio_path)
    
    def _transcribe_sync(self, audio_path: str) -> str:
        """Synchronous transcription."""
        model = self._get_model()
        
        segments, info = model.transcribe(
            audio_path,
            beam_size=5,
            language=None,  # Auto-detect language
            vad_filter=True,  # Filter out non-speech
        )
        
        # Combine all segments
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())
        
        return " ".join(text_parts)


class WhisperAPIService:
    """
    External Whisper API service.
    
    Compatible with:
    - openai-whisper-asr-webservice (Docker: onerahmet/openai-whisper-asr-webservice)
    - Any OpenAI-compatible /v1/audio/transcriptions endpoint
    """
    
    def __init__(self, api_url: str):
        """
        Initialize Whisper API service.
        
        Args:
            api_url: Base URL of the Whisper API (e.g., http://localhost:9000)
        """
        self.api_url = api_url.rstrip("/")
    
    async def transcribe(self, audio_path: str) -> str:
        """
        Transcribe audio using external API.
        
        Args:
            audio_path: Path to audio file
        
        Returns:
            Transcribed text
        """
        # Try OpenAI-compatible endpoint first
        endpoint = f"{self.api_url}/v1/audio/transcriptions"
        
        async with aiohttp.ClientSession() as session:
            with open(audio_path, "rb") as f:
                data = aiohttp.FormData()
                data.add_field(
                    "file",
                    f,
                    filename=Path(audio_path).name,
                    content_type="audio/ogg",
                )
                data.add_field("model", "whisper-1")
                data.add_field("response_format", "text")
                
                async with session.post(endpoint, data=data) as response:
                    if response.status == 200:
                        return await response.text()
                    
                    # Try alternative endpoint format
                    pass
        
        # Try simple /asr endpoint (openai-whisper-asr-webservice format)
        endpoint = f"{self.api_url}/asr"
        
        async with aiohttp.ClientSession() as session:
            with open(audio_path, "rb") as f:
                data = aiohttp.FormData()
                data.add_field(
                    "audio_file",
                    f,
                    filename=Path(audio_path).name,
                )
                
                params = {
                    "task": "transcribe",
                    "output": "txt",
                }
                
                async with session.post(endpoint, data=data, params=params) as response:
                    if response.status == 200:
                        return await response.text()
                    
                    error = await response.text()
                    raise Exception(f"Whisper API error ({response.status}): {error}")


def create_transcription_service(
    mode: str,
    model: str = "base",
    api_url: str | None = None,
) -> TranscriptionService:
    """
    Factory function to create a transcription service.
    
    Args:
        mode: 'local' for faster-whisper, 'api' for external API
        model: Model size for local mode
        api_url: API URL for api mode
    
    Returns:
        TranscriptionService instance
    """
    if mode == "local":
        return LocalWhisperService(model_size=model)
    elif mode == "api":
        if not api_url:
            raise ValueError("api_url is required for API mode")
        return WhisperAPIService(api_url)
    else:
        raise ValueError(f"Unknown transcription mode: {mode}")


async def convert_ogg_to_wav(ogg_path: str) -> str:
    """
    Convert OGG audio to WAV format using pydub.
    
    Telegram voice messages are in OGG Opus format.
    
    Args:
        ogg_path: Path to OGG file
    
    Returns:
        Path to converted WAV file
    """
    from pydub import AudioSegment
    
    loop = asyncio.get_event_loop()
    
    def convert():
        audio = AudioSegment.from_ogg(ogg_path)
        wav_path = ogg_path.replace(".ogg", ".wav")
        audio.export(wav_path, format="wav")
        return wav_path
    
    return await loop.run_in_executor(None, convert)

