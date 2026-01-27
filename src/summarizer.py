"""
DeepSeek API integration for text summarization.
"""

from openai import AsyncOpenAI


class DeepSeekSummarizer:
    """Summarizer using DeepSeek API (OpenAI-compatible)."""
    
    def __init__(self, api_key: str, api_url: str = "https://api.deepseek.com"):
        """
        Initialize DeepSeek summarizer.
        
        Args:
            api_key: DeepSeek API key
            api_url: DeepSeek API URL (default: https://api.deepseek.com)
        """
        self.client = AsyncOpenAI(
            api_key=api_key,
            base_url=f"{api_url}/v1" if not api_url.endswith("/v1") else api_url,
        )
        self.model = "deepseek-chat"
    
    async def summarize(self, text: str, language: str = "auto") -> str:
        """
        Summarize the given text.
        
        Args:
            text: Text to summarize
            language: Target language for summary (auto = same as input)
        
        Returns:
            Summary of the text
        """
        system_prompt = """You are a helpful assistant that creates concise summaries of voice message transcriptions.

Your task:
1. Create a clear, concise summary of the main points
2. Keep the summary in the same language as the original text
3. Preserve key information, names, dates, and action items
4. Use bullet points for multiple distinct topics
5. Be concise but don't lose important details

Format your response as a clean summary without any preamble like "Here's a summary:" - just provide the summary directly."""

        user_prompt = f"""Please summarize the following voice message transcription:

---
{text}
---

Provide a concise summary."""

        response = await self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=1000,
        )
        
        return response.choices[0].message.content or ""
    
    async def close(self):
        """Close the client connection."""
        await self.client.close()


def create_summarizer(api_key: str, api_url: str = "https://api.deepseek.com") -> DeepSeekSummarizer:
    """Factory function to create a DeepSeek summarizer."""
    return DeepSeekSummarizer(api_key, api_url)





