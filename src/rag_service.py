"""
RAG (Retrieval-Augmented Generation) Service.

Uses ChromaDB for vector storage and sentence-transformers for embeddings.
Optimized for low-memory servers (8GB RAM).
"""

import logging
import asyncio
from pathlib import Path
from typing import Any
from datetime import datetime

logger = logging.getLogger(__name__)

# Lazy loading for heavy dependencies
_embedder = None
_chroma_client = None


def get_embedder():
    """Lazy-load the embedding model to save memory."""
    global _embedder
    if _embedder is None:
        logger.info("Loading embedding model (multilingual-e5-small)...")
        from sentence_transformers import SentenceTransformer
        # Using small model to save RAM (~0.8GB instead of 1.5GB)
        _embedder = SentenceTransformer('intfloat/multilingual-e5-small')
        logger.info("Embedding model loaded!")
    return _embedder


class RAGService:
    """
    RAG service for semantic search over notes.
    
    Features:
    - Semantic search using embeddings
    - ChromaDB for persistent vector storage
    - Automatic indexing of new notes
    - Memory-efficient (uses small model)
    """
    
    def __init__(self, db_path: str = "./data/vectordb"):
        """
        Initialize RAG service.
        
        Args:
            db_path: Path to ChromaDB persistent storage
        """
        self.db_path = Path(db_path)
        self.db_path.mkdir(parents=True, exist_ok=True)
        self._collection = None
        self._initialized = False
    
    def _get_collection(self):
        """Get or create the ChromaDB collection."""
        if self._collection is None:
            import chromadb
            
            logger.info(f"Initializing ChromaDB at {self.db_path}")
            client = chromadb.PersistentClient(path=str(self.db_path))
            
            self._collection = client.get_or_create_collection(
                name="notes",
                metadata={"hnsw:space": "cosine"}
            )
            logger.info(f"ChromaDB collection ready, {self._collection.count()} documents")
        
        return self._collection
    
    async def add_note(
        self,
        note_id: str,
        text: str,
        metadata: dict[str, Any] | None = None
    ) -> bool:
        """
        Add or update a note in the vector database.
        
        Args:
            note_id: Unique identifier for the note
            text: Full text content of the note
            metadata: Additional metadata (title, date, source, etc.)
        
        Returns:
            True if successful
        """
        if not text or len(text.strip()) < 20:
            logger.warning(f"Note {note_id} too short, skipping")
            return False
        
        try:
            # Run embedding in thread pool (CPU-intensive)
            loop = asyncio.get_event_loop()
            embedding = await loop.run_in_executor(
                None,
                lambda: get_embedder().encode(text).tolist()
            )
            
            collection = self._get_collection()
            
            # Prepare metadata
            meta = metadata or {}
            meta['indexed_at'] = datetime.now().isoformat()
            meta['text_length'] = len(text)
            
            # ChromaDB doesn't like None values
            meta = {k: v for k, v in meta.items() if v is not None}
            
            # Upsert (add or update)
            # First try to delete existing
            try:
                collection.delete(ids=[note_id])
            except Exception:
                pass
            
            collection.add(
                ids=[note_id],
                documents=[text],
                metadatas=[meta],
                embeddings=[embedding]
            )
            
            logger.info(f"Indexed note {note_id} ({len(text)} chars)")
            return True
            
        except Exception as e:
            logger.error(f"Error indexing note {note_id}: {e}")
            return False
    
    async def search(
        self,
        query: str,
        n_results: int = 5,
        min_similarity: float = 0.3
    ) -> list[dict[str, Any]]:
        """
        Search for notes similar to the query.
        
        Args:
            query: Search query (natural language)
            n_results: Maximum number of results
            min_similarity: Minimum similarity threshold (0-1)
        
        Returns:
            List of matching notes with text, metadata, and similarity score
        """
        if not query or len(query.strip()) < 3:
            return []
        
        try:
            # Create query embedding
            loop = asyncio.get_event_loop()
            query_embedding = await loop.run_in_executor(
                None,
                lambda: get_embedder().encode(query).tolist()
            )
            
            collection = self._get_collection()
            
            if collection.count() == 0:
                logger.info("No documents in collection")
                return []
            
            # Search
            results = collection.query(
                query_embeddings=[query_embedding],
                n_results=min(n_results, collection.count()),
                include=["documents", "metadatas", "distances"]
            )
            
            # Process results
            notes = []
            for i, doc in enumerate(results['documents'][0]):
                # ChromaDB returns distance, convert to similarity
                distance = results['distances'][0][i]
                similarity = 1 - distance  # Cosine distance to similarity
                
                if similarity < min_similarity:
                    continue
                
                notes.append({
                    'id': results['ids'][0][i],
                    'text': doc,
                    'metadata': results['metadatas'][0][i] if results['metadatas'] else {},
                    'similarity': round(similarity, 3)
                })
            
            logger.info(f"Search '{query[:50]}...' found {len(notes)} results")
            return notes
            
        except Exception as e:
            logger.error(f"Search error: {e}")
            return []
    
    async def delete_note(self, note_id: str) -> bool:
        """Delete a note from the vector database."""
        try:
            collection = self._get_collection()
            collection.delete(ids=[note_id])
            logger.info(f"Deleted note {note_id}")
            return True
        except Exception as e:
            logger.error(f"Error deleting note {note_id}: {e}")
            return False
    
    def get_stats(self) -> dict[str, Any]:
        """Get statistics about the vector database."""
        try:
            collection = self._get_collection()
            return {
                'total_notes': collection.count(),
                'db_path': str(self.db_path),
                'model': 'multilingual-e5-small'
            }
        except Exception as e:
            return {'error': str(e)}
    
    async def clear_all(self) -> bool:
        """Clear all notes from the database. Use with caution!"""
        try:
            import chromadb
            client = chromadb.PersistentClient(path=str(self.db_path))
            client.delete_collection("notes")
            self._collection = None
            logger.warning("Cleared all notes from vector database!")
            return True
        except Exception as e:
            logger.error(f"Error clearing database: {e}")
            return False


class SyncService:
    """
    Service for syncing notes from Anytype to the vector database.
    """
    
    def __init__(self, anytype_client, rag_service: RAGService):
        """
        Initialize sync service.
        
        Args:
            anytype_client: AnytypeClient instance
            rag_service: RAGService instance
        """
        self.anytype = anytype_client
        self.rag = rag_service
    
    async def sync_all_notes(self) -> dict[str, int]:
        """
        Sync all notes from Anytype to the vector database.
        
        Returns:
            Dict with sync statistics
        """
        logger.info("Starting full sync from Anytype...")
        
        stats = {'synced': 0, 'skipped': 0, 'errors': 0}
        
        try:
            # Search for all Note objects
            # Using empty query to get all
            response = await self.anytype._request(
                "POST",
                f"/spaces/{self.anytype.space_id}/objects/search",
                json_data={
                    "query": "",
                    "types": ["ot-note"],
                    "limit": 1000
                }
            )
            
            objects = response.get("data", [])
            logger.info(f"Found {len(objects)} notes in Anytype")
            
            for obj in objects:
                try:
                    obj_id = obj.get("id")
                    name = obj.get("name", "")
                    
                    # Get full object with body
                    full_obj = await self.anytype.get_object(obj_id)
                    body = full_obj.get("body", "")
                    
                    # Combine name and body for indexing
                    full_text = f"{name}\n\n{body}" if body else name
                    
                    if len(full_text) < 20:
                        stats['skipped'] += 1
                        continue
                    
                    # Index the note
                    success = await self.rag.add_note(
                        note_id=obj_id,
                        text=full_text,
                        metadata={
                            'title': name,
                            'source': 'anytype',
                            'anytype_id': obj_id,
                            'created': obj.get('created_date', ''),
                        }
                    )
                    
                    if success:
                        stats['synced'] += 1
                    else:
                        stats['skipped'] += 1
                        
                except Exception as e:
                    logger.error(f"Error syncing object {obj.get('id')}: {e}")
                    stats['errors'] += 1
            
            logger.info(f"Sync complete: {stats}")
            return stats
            
        except Exception as e:
            logger.error(f"Sync error: {e}")
            stats['errors'] += 1
            return stats


def create_rag_service(db_path: str = "./data/vectordb") -> RAGService:
    """Factory function to create a RAG service."""
    return RAGService(db_path)

