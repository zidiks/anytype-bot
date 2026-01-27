"""
Anytype API Client for creating objects and managing references.

Based on Anytype API documentation: https://developers.anytype.io/docs/reference
"""

import aiohttp
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass
class CreatedObject:
    object_id: str
    space_id: str
    name: str


class AnytypeClient:
    """Client for interacting with Anytype API."""
    
    # API version from https://developers.anytype.io/docs/reference
    API_VERSION = "2025-05-20"
    
    def __init__(self, api_url: str, bearer_token: str, space_id: str):
        # Ensure /v1 prefix for API
        base_url = api_url.rstrip("/")
        if not base_url.endswith("/v1"):
            base_url = f"{base_url}/v1"
        self.api_url = base_url
        self.bearer_token = bearer_token
        self.space_id = space_id
        self._session: aiohttp.ClientSession | None = None
    
    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/json",
            "Anytype-Version": self.API_VERSION,
        }
    
    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers=self.headers)
        return self._session
    
    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
    
    async def _request(
        self, 
        method: str, 
        endpoint: str, 
        json_data: dict | None = None
    ) -> dict[str, Any]:
        """Make an API request."""
        session = await self._get_session()
        url = f"{self.api_url}{endpoint}"
        
        async with session.request(method, url, json=json_data) as response:
            # Check content type before parsing
            content_type = response.headers.get("Content-Type", "")
            
            if "application/json" in content_type:
                response_data = await response.json()
            else:
                # Handle non-JSON response (likely an error)
                text = await response.text()
                raise Exception(f"Anytype API error ({response.status}): {text}")
            
            if not response.ok:
                error_msg = response_data.get("error", {}).get("message", str(response_data))
                raise Exception(f"Anytype API error ({response.status}): {error_msg}")
            
            return response_data
    
    async def get_types(self) -> list[dict]:
        """Get all available types in the space."""
        response = await self._request("GET", f"/spaces/{self.space_id}/types")
        return response.get("data", [])
    
    async def get_note_type_id(self) -> str | None:
        """Find the Note type ID in the space."""
        types = await self.get_types()
        for t in types:
            # Look for Note type by name or key
            if t.get("name", "").lower() == "note" or t.get("key") == "ot-note":
                return t.get("id")
        return None
    
    async def create_object(
        self,
        name: str,
        body: str,
        type_key: str = "ot-note",
        icon_emoji: str = "📝",
    ) -> CreatedObject:
        """
        Create a new object in the space.
        
        Args:
            name: Title of the object
            body: Content of the object (supports markdown)
            type_key: Type key for the object (default: ot-note for Note type)
            icon_emoji: Emoji icon for the object
        
        Returns:
            CreatedObject with the new object's details
        """
        payload: dict[str, Any] = {
            "name": name,
            "icon": {
                "format": "emoji",
                "emoji": icon_emoji,
            },
            "body": body,
            "type_key": type_key,
        }
        
        response = await self._request(
            "POST", 
            f"/spaces/{self.space_id}/objects",
            json_data=payload
        )
        
        obj_data = response.get("data", response.get("object", {}))
        
        return CreatedObject(
            object_id=obj_data.get("id", ""),
            space_id=self.space_id,
            name=name,
        )
    
    async def get_object(self, object_id: str) -> dict[str, Any]:
        """Get object details by ID."""
        response = await self._request("GET", f"/spaces/{self.space_id}/objects/{object_id}")
        return response.get("data", response.get("object", {}))
    
    async def update_object(
        self,
        object_id: str,
        name: str | None = None,
        body: str | None = None,
        icon_emoji: str | None = None,
    ) -> dict[str, Any]:
        """Update an existing object."""
        payload: dict[str, Any] = {}
        
        if name is not None:
            payload["name"] = name
        if body is not None:
            payload["body"] = body
        if icon_emoji is not None:
            payload["icon"] = {
                "format": "emoji",
                "emoji": icon_emoji,
            }
        
        response = await self._request(
            "PATCH",
            f"/spaces/{self.space_id}/objects/{object_id}",
            json_data=payload
        )
        
        return response.get("data", response.get("object", {}))
    
    async def add_block_to_object(
        self,
        object_id: str,
        block_type: str,
        content: str,
    ) -> dict[str, Any]:
        """
        Add a new block to an object.
        
        Args:
            object_id: ID of the object to add block to
            block_type: Type of block (text, quote, link, etc.)
            content: Content of the block
        """
        payload = {
            "type": block_type,
            "content": content,
        }
        
        response = await self._request(
            "POST",
            f"/spaces/{self.space_id}/objects/{object_id}/blocks",
            json_data=payload
        )
        
        return response.get("data", {})
    
    async def create_voice_note(
        self,
        summary: str,
        full_text: str,
        timestamp: datetime | None = None,
        username: str | None = None,
    ) -> CreatedObject:
        """
        Create a voice note with summary and full transcription.
        
        Args:
            summary: DeepSeek-generated summary
            full_text: Full transcription text
            timestamp: Optional timestamp for the note title
            username: Telegram username of the sender
        
        Returns:
            CreatedObject with the new note's details
        """
        if timestamp is None:
            timestamp = datetime.now()
        
        # Create title with username and timestamp
        user_part = f"@{username}" if username else "Unknown"
        title_preview = summary[:40].split("\n")[0]
        if len(summary) > 40:
            title_preview += "..."
        
        title = f"🎤 [{user_part}] {timestamp.strftime('%Y-%m-%d %H:%M')} - {title_preview}"
        
        # Build body with summary and full text as quote
        body = f"""## Summary

{summary}

---

## Full Transcription

> {full_text.replace(chr(10), chr(10) + '> ')}
"""
        
        return await self.create_object(
            name=title,
            body=body,
            icon_emoji="🎤",
        )
    
async def create_anytype_client(
    api_url: str,
    bearer_token: str, 
    space_id: str
) -> AnytypeClient:
    """Factory function to create an Anytype client."""
    return AnytypeClient(api_url, bearer_token, space_id)

