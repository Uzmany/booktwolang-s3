"""BookTwoLang API — FastAPI service for chunked, AI-powered document translation.

Frontend lives at https://booktwolang.com (S3 + CloudFront).
This API is served at https://api.booktwolang.com on port 8001 behind the
shared ``ketzek-lb`` ALB on EC2 i-0f9e1d882c3ada3a4.
"""

from __future__ import annotations

import io
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Iterable

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .translate import (
    LANGUAGES,
    TranslationError,
    chunk_text,
    language_name,
    translate_chunk,
)
from .users import get_current_user, router as users_router

REGION = os.getenv("AWS_REGION", "us-east-1")
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(5 * 1024 * 1024)))
MAX_TEXT_CHARS = int(os.getenv("MAX_TEXT_CHARS", str(2_000_000)))
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "https://booktwolang.com,https://www.booktwolang.com,http://localhost:5173,http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000",
    ).split(",")
    if o.strip()
]

_dynamodb = boto3.resource("dynamodb", region_name=REGION)
documents_table = _dynamodb.Table("booktwolang_documents")

app = FastAPI(title="BookTwoLang API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(users_router)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _doc_pk(doc_id: str) -> str:
    return f"DOC#{doc_id}"


def _meta_to_public(meta: dict) -> dict:
    return {
        "docId": meta["docId"],
        "title": meta.get("title", "Untitled"),
        "sourceLang": meta.get("sourceLang", "auto"),
        "targetLang": meta.get("targetLang"),
        "status": meta.get("status", "pending"),
        "createdAt": meta.get("createdAt"),
        "updatedAt": meta.get("updatedAt"),
        "sourceChars": int(meta.get("sourceChars", 0)),
        "totalChunks": int(meta.get("totalChunks", 0)),
        "completedChunks": int(meta.get("completedChunks", 0)),
        "model": meta.get("model"),
        "error": meta.get("error"),
    }


def _extract_text(filename: str, raw: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith(".docx"):
        try:
            from docx import Document
        except ImportError as exc:
            raise HTTPException(500, "python-docx is not installed on the server") from exc
        try:
            doc = Document(io.BytesIO(raw))
        except Exception as exc:
            raise HTTPException(400, f"Could not parse .docx: {exc}")
        return "\n\n".join(p.text for p in doc.paragraphs if p.text is not None)

    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return raw.decode("latin-1")
        except Exception as exc:
            raise HTTPException(400, f"Could not decode file as text: {exc}")


def _query_chunks(doc_id: str, prefix: str) -> list[dict]:
    items: list[dict] = []
    kwargs = {
        "KeyConditionExpression": Key("PK").eq(_doc_pk(doc_id)) & Key("SK").begins_with(prefix),
    }
    while True:
        resp = documents_table.query(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    items.sort(key=lambda it: it["SK"])
    return items


def _get_meta(doc_id: str) -> dict | None:
    resp = documents_table.get_item(Key={"PK": _doc_pk(doc_id), "SK": "META"})
    return resp.get("Item")


def _update_meta(doc_id: str, updates: dict[str, object]) -> None:
    expr_parts = ["#updatedAt = :updatedAt"]
    names: dict[str, str] = {"#updatedAt": "updatedAt"}
    values: dict[str, object] = {":updatedAt": _now_iso()}
    for i, (key, value) in enumerate(updates.items()):
        n = f"#k{i}"
        v = f":v{i}"
        names[n] = key
        values[v] = value
        expr_parts.append(f"{n} = {v}")
    documents_table.update_item(
        Key={"PK": _doc_pk(doc_id), "SK": "META"},
        UpdateExpression="SET " + ", ".join(expr_parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _enforce_owner(meta: dict, user_id: str) -> None:
    if meta.get("ownerId") != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your document")


class CreateDocRequest(BaseModel):
    title: str = Field(default="Untitled", max_length=200)
    sourceLang: str = Field(default="auto", max_length=20)
    sourceText: str


class TranslateRequest(BaseModel):
    targetLang: str = Field(min_length=2, max_length=20)
    model: str | None = Field(default=None, max_length=80)


@app.get("/")
def health():
    return {"status": "ok", "service": "booktwolang-api"}


@app.get("/v1/languages")
def list_languages():
    return {"languages": [{"code": k, "name": v} for k, v in LANGUAGES.items()]}


@app.get("/v1/documents")
def list_documents(current_user: dict = Depends(get_current_user)):
    resp = documents_table.query(
        IndexName="UserDocuments",
        KeyConditionExpression=Key("GSI1PK").eq(f"USER#{current_user['userId']}"),
        ScanIndexForward=False,
        Limit=100,
    )
    docs = [_meta_to_public(it) for it in resp.get("Items", []) if it.get("SK") == "META"]
    return {"documents": docs}


def _persist_source(doc_id: str, source_text: str) -> int:
    chunks = chunk_text(source_text)
    with documents_table.batch_writer() as batch:
        for idx, chunk in enumerate(chunks):
            batch.put_item(
                Item={
                    "PK": _doc_pk(doc_id),
                    "SK": f"SRC#{idx:05d}",
                    "text": chunk,
                }
            )
    return len(chunks)


@app.post("/v1/documents", status_code=status.HTTP_201_CREATED)
async def create_document(
    body: CreateDocRequest | None = None,
    file: UploadFile | None = File(default=None),
    title: str | None = Form(default=None),
    sourceLang: str | None = Form(default=None),
    current_user: dict = Depends(get_current_user),
):
    if file is not None:
        raw = await file.read()
        if len(raw) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"File too large (max {MAX_UPLOAD_BYTES // 1024 // 1024}MB)")
        text = _extract_text(file.filename or "", raw)
        doc_title = title or (file.filename or "Untitled").rsplit(".", 1)[0][:200]
        source_lang = (sourceLang or "auto")[:20]
    elif body is not None:
        text = body.sourceText
        doc_title = body.title[:200]
        source_lang = body.sourceLang[:20]
    else:
        raise HTTPException(400, "Provide either JSON body or multipart file upload")

    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "Source text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"Text too long (max {MAX_TEXT_CHARS:,} chars)")

    doc_id = uuid.uuid4().hex
    created_at = _now_iso()
    total_chunks = _persist_source(doc_id, text)
    meta = {
        "PK": _doc_pk(doc_id),
        "SK": "META",
        "docId": doc_id,
        "title": doc_title,
        "ownerId": current_user["userId"],
        "sourceLang": source_lang,
        "targetLang": None,
        "status": "ready",
        "sourceChars": len(text),
        "totalChunks": total_chunks,
        "completedChunks": 0,
        "createdAt": created_at,
        "updatedAt": created_at,
        "GSI1PK": f"USER#{current_user['userId']}",
        "GSI1SK": created_at,
    }
    documents_table.put_item(Item=meta)
    return _meta_to_public(meta)


@app.get("/v1/documents/{doc_id}")
def get_document(doc_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(doc_id)
    if not meta:
        raise HTTPException(404, "Document not found")
    _enforce_owner(meta, current_user["userId"])
    return _meta_to_public(meta)


@app.delete("/v1/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(doc_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(doc_id)
    if not meta:
        return
    _enforce_owner(meta, current_user["userId"])
    items = documents_table.query(
        KeyConditionExpression=Key("PK").eq(_doc_pk(doc_id)),
        ProjectionExpression="PK, SK",
    ).get("Items", [])
    with documents_table.batch_writer() as batch:
        for it in items:
            batch.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})


@app.get("/v1/documents/{doc_id}/source")
def get_source(doc_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(doc_id)
    if not meta:
        raise HTTPException(404, "Document not found")
    _enforce_owner(meta, current_user["userId"])
    chunks = _query_chunks(doc_id, "SRC#")
    return {"docId": doc_id, "text": "\n\n".join(c.get("text", "") for c in chunks)}


@app.get("/v1/documents/{doc_id}/translated")
def get_translated(doc_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(doc_id)
    if not meta:
        raise HTTPException(404, "Document not found")
    _enforce_owner(meta, current_user["userId"])
    chunks = _query_chunks(doc_id, "TRN#")
    return {
        "docId": doc_id,
        "status": meta.get("status"),
        "completedChunks": int(meta.get("completedChunks", 0)),
        "totalChunks": int(meta.get("totalChunks", 0)),
        "text": "\n\n".join(c.get("text", "") for c in chunks),
    }


def _run_translation(doc_id: str, target_lang: str, model: str | None) -> None:
    """Background worker — translate every SRC chunk into a TRN chunk."""
    try:
        meta = _get_meta(doc_id)
        if not meta:
            return
        source_lang = meta.get("sourceLang", "auto")
        src_chunks = _query_chunks(doc_id, "SRC#")
        completed = 0
        for it in src_chunks:
            idx = it["SK"].split("#", 1)[1]
            existing = documents_table.get_item(
                Key={"PK": _doc_pk(doc_id), "SK": f"TRN#{idx}"}
            ).get("Item")
            if existing:
                completed += 1
                continue
            translated = translate_chunk(
                it.get("text", ""),
                source_lang=source_lang,
                target_lang=target_lang,
                model=model,
            )
            documents_table.put_item(
                Item={
                    "PK": _doc_pk(doc_id),
                    "SK": f"TRN#{idx}",
                    "text": translated,
                }
            )
            completed += 1
            _update_meta(doc_id, {"completedChunks": completed})
        _update_meta(doc_id, {"status": "complete", "completedChunks": completed, "error": ""})
    except TranslationError as exc:
        _update_meta(doc_id, {"status": "failed", "error": str(exc)[:500]})
    except Exception as exc:  # pragma: no cover — defensive
        _update_meta(doc_id, {"status": "failed", "error": f"unexpected: {exc}"[:500]})


@app.post("/v1/documents/{doc_id}/translate")
def start_translation(
    doc_id: str,
    body: TranslateRequest,
    background: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    meta = _get_meta(doc_id)
    if not meta:
        raise HTTPException(404, "Document not found")
    _enforce_owner(meta, current_user["userId"])
    if body.targetLang not in LANGUAGES:
        raise HTTPException(400, f"Unsupported target language: {body.targetLang}")
    if meta.get("status") == "translating":
        raise HTTPException(409, "Translation already in progress")

    _update_meta(
        doc_id,
        {
            "status": "translating",
            "targetLang": body.targetLang,
            "model": body.model or "",
            "completedChunks": 0,
            "error": "",
        },
    )
    background.add_task(_run_translation, doc_id, body.targetLang, body.model)
    return {"docId": doc_id, "status": "translating", "targetLang": body.targetLang}
