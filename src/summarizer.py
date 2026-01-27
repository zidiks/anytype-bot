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
    
    async def summarize_chunk(self, text: str, chunk_number: int, meeting_title: str) -> str:
        """
        Generate a brief summary for a chunk of meeting content.
        Used for intermediate summaries during long meetings.
        
        Args:
            text: Text chunk to summarize
            chunk_number: Number of this chunk (1, 2, 3...)
            meeting_title: Title of the meeting
        
        Returns:
            Brief summary of the chunk
        """
        system_prompt = """You are a meeting summarizer. Create a brief summary of this meeting segment.
Focus on:
- Key points discussed
- Decisions made
- Action items mentioned
- Important names or topics

Be concise (2-4 sentences). Write in the same language as the transcript."""

        user_prompt = f"""Summarize segment #{chunk_number} of meeting "{meeting_title}":

{text}"""

        response = await self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=300,
        )
        
        return response.choices[0].message.content or ""
    
    async def combine_summaries(self, intermediate_summaries: list, meeting_title: str) -> str:
        """
        Combine multiple intermediate summaries into a final cohesive summary.
        
        Args:
            intermediate_summaries: List of summary dicts with 'chunkNumber' and 'summary'
            meeting_title: Title of the meeting
        
        Returns:
            Final combined summary
        """
        # Format intermediate summaries
        summaries_text = "\n\n".join(
            f"[Part {s.get('chunkNumber', i+1)}]: {s.get('summary', '')}"
            for i, s in enumerate(intermediate_summaries)
        )
        
        system_prompt = """You are a meeting summarizer. You will receive summaries of different parts of a long meeting.
Create a cohesive final summary that:
- Covers all key points from all parts
- Highlights important decisions and action items
- Maintains chronological flow where relevant
- Is comprehensive but concise

Write in the same language as the input summaries."""

        user_prompt = f"""Create a final summary for meeting "{meeting_title}" from these part summaries:

{summaries_text}"""

        response = await self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=1500,
        )
        
        return response.choices[0].message.content or ""
    
    async def close(self):
        """Close the client connection."""
        await self.client.close()


def create_summarizer(api_key: str, api_url: str = "https://api.deepseek.com") -> DeepSeekSummarizer:
    """Factory function to create a DeepSeek summarizer."""
    return DeepSeekSummarizer(api_key, api_url)





