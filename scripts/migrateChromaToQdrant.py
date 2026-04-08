#!/usr/bin/env python3
"""Migrate existing ChromaDB palace to Qdrant.

Requirements: pip install chromadb qdrant-client
Usage: python scripts/migrateChromaToQdrant.py --chroma-path ~/.mempalace/palace --qdrant-url http://localhost:6333 --collection mempalace_drawers
"""
import argparse
import uuid
import chromadb
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

def deterministic_uuid(string_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"mempalace.{string_id}"))

def migrate(chroma_path: str, qdrant_url: str, collection_name: str):
    # Connect to ChromaDB
    chroma = chromadb.PersistentClient(path=chroma_path)
    col = chroma.get_collection(collection_name)

    # Get all data with embeddings
    data = col.get(include=["documents", "metadatas", "embeddings"])
    total = len(data["ids"])
    print(f"Found {total} drawers in ChromaDB")

    if total == 0:
        print("Nothing to migrate")
        return

    # Connect to Qdrant
    qdrant = QdrantClient(url=qdrant_url)

    # Create collection (safe — won't destroy existing data)
    vector_size = len(data["embeddings"][0])
    try:
        qdrant.get_collection(collection_name)
        print(f"Collection '{collection_name}' already exists, upserting into it")
    except Exception:
        qdrant.create_collection(
            collection_name=collection_name,
            vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
        )
        print(f"Created collection '{collection_name}'")

    # Batch upsert
    batch_size = 500
    for i in range(0, total, batch_size):
        batch_end = min(i + batch_size, total)
        points = []
        for j in range(i, batch_end):
            point_id = deterministic_uuid(data["ids"][j])
            payload = {
                "document": data["documents"][j],
                "original_id": data["ids"][j],
                **(data["metadatas"][j] or {}),
            }
            points.append(PointStruct(id=point_id, vector=data["embeddings"][j], payload=payload))
        qdrant.upsert(collection_name=collection_name, points=points)
        print(f"  Migrated {batch_end}/{total}")

    # Verify
    qdrant_count = qdrant.count(collection_name).count
    print(f"\nVerification: ChromaDB={total}, Qdrant={qdrant_count}")
    if total == qdrant_count:
        print("Migration successful!")
    else:
        print("WARNING: Count mismatch!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate ChromaDB to Qdrant")
    parser.add_argument("--chroma-path", required=True, help="Path to ChromaDB data directory")
    parser.add_argument("--qdrant-url", default="http://localhost:6333", help="Qdrant server URL")
    parser.add_argument("--collection", default="mempalace_drawers", help="Collection name")
    args = parser.parse_args()
    migrate(args.chroma_path, args.qdrant_url, args.collection)
