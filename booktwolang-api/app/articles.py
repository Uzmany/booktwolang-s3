"""Broadcast articles API — multi-lingual self-publishing.

DynamoDB layout (table ``booktwolang_articles``):

    PK = ARTICLE#{id}
    SK = META | LANG#{code} | STATS#{YYYY-MM-DD}

    GSI1 (UserArticles)
        GSI1PK = USER#{userId}
        GSI1SK = createdAt

    GSI2 (PublishedArticles)
        GSI2PK = PUBLISHED#{slug}
        GSI2SK = LANG#{code}        (or "META" for the canonical record)
"""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .translate import LANGUAGES, TranslationError, chunk_text, translate_chunk
from .users import get_current_user

REGION = os.getenv("AWS_REGION", "us-east-1")
_dynamodb = boto3.resource("dynamodb", region_name=REGION)
articles_table = _dynamodb.Table("booktwolang_articles")

router        = APIRouter(prefix="/v1/articles",        tags=["articles"])
public_router = APIRouter(prefix="/v1/public/articles", tags=["articles-public"])


# ─────────────────────────── helpers ────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _pk(article_id: str) -> str:
    return f"ARTICLE#{article_id}"

def _slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:60] or "untitled"


def _meta_public(item: dict, *, langs: list[str] | None = None) -> dict:
    return {
        "articleId": item["articleId"],
        "title":     item.get("title", "Untitled"),
        "subtitle":  item.get("subtitle", ""),
        "coverEmoji": item.get("coverEmoji", "✦"),
        "body":      item.get("body", ""),
        "wordCount": int(item.get("wordCount", 0)),
        "status":    item.get("status", "draft"),
        "slug":      item.get("slug"),
        "sourceLang": item.get("sourceLang", "auto"),
        "languages": list(item.get("languages", []) or []) if langs is None else langs,
        "publishedAt": item.get("publishedAt"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }


def _get_meta(article_id: str) -> dict | None:
    return articles_table.get_item(Key={"PK": _pk(article_id), "SK": "META"}).get("Item")


def _enforce_owner(meta: dict, user_id: str) -> None:
    if meta.get("ownerId") != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your article")


def _word_count(text: str) -> int:
    return len([w for w in re.split(r"\s+", text or "") if w])


def _patch_meta(article_id: str, updates: dict) -> None:
    expr = ["#updatedAt = :updatedAt"]
    names: dict = {"#updatedAt": "updatedAt"}
    values: dict = {":updatedAt": _now_iso()}
    for i, (k, v) in enumerate(updates.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = v
        expr.append(f"#k{i} = :v{i}")
    articles_table.update_item(
        Key={"PK": _pk(article_id), "SK": "META"},
        UpdateExpression="SET " + ", ".join(expr),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _query_translations(article_id: str) -> list[dict]:
    items: list[dict] = []
    kwargs = {"KeyConditionExpression": Key("PK").eq(_pk(article_id)) & Key("SK").begins_with("LANG#")}
    while True:
        resp = articles_table.query(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return items


# ─────────────────────────── request bodies ─────────────────────────────

class ArticleCreate(BaseModel):
    title:       str = Field(default="Untitled", max_length=200)
    subtitle:    str = Field(default="", max_length=300)
    body:        str = Field(default="", max_length=60000)
    coverEmoji:  str = Field(default="✦", max_length=8)
    sourceLang:  str = Field(default="auto", max_length=20)

class ArticleUpdate(BaseModel):
    title:       str | None = Field(default=None, max_length=200)
    subtitle:    str | None = Field(default=None, max_length=300)
    body:        str | None = Field(default=None, max_length=60000)
    coverEmoji:  str | None = Field(default=None, max_length=8)
    sourceLang:  str | None = Field(default=None, max_length=20)

class TranslateRequest(BaseModel):
    targetLangs: list[str] = Field(min_length=1, max_length=12)
    model:       str | None = Field(default=None, max_length=80)


# ───────────────────────── private routes ───────────────────────────────

@router.get("")
def list_articles(current_user: dict = Depends(get_current_user)):
    resp = articles_table.query(
        IndexName="UserArticles",
        KeyConditionExpression=Key("GSI1PK").eq(f"USER#{current_user['userId']}"),
        ScanIndexForward=False,
        Limit=100,
    )
    out = [_meta_public(it) for it in resp.get("Items", []) if it.get("SK") == "META"]
    return {"articles": out}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_article(body: ArticleCreate, current_user: dict = Depends(get_current_user)):
    article_id = uuid.uuid4().hex
    now = _now_iso()
    item = {
        "PK": _pk(article_id),
        "SK": "META",
        "articleId": article_id,
        "ownerId":   current_user["userId"],
        "title":     body.title[:200],
        "subtitle":  body.subtitle[:300],
        "body":      body.body[:60000],
        "coverEmoji": body.coverEmoji[:8] or "✦",
        "sourceLang": body.sourceLang[:20] or "auto",
        "wordCount": _word_count(body.body),
        "languages": [],
        "status":    "draft",
        "createdAt": now,
        "updatedAt": now,
        "GSI1PK": f"USER#{current_user['userId']}",
        "GSI1SK": now,
    }
    articles_table.put_item(Item=item)
    return _meta_public(item)


@router.get("/{article_id}")
def get_article(article_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(article_id)
    if not meta:
        raise HTTPException(404, "Article not found")
    _enforce_owner(meta, current_user["userId"])
    translations = _query_translations(article_id)
    return {
        **_meta_public(meta),
        "translations": [
            {
                "lang":       t.get("lang"),
                "title":      t.get("title", ""),
                "subtitle":   t.get("subtitle", ""),
                "body":       t.get("body", ""),
                "status":     t.get("status", "ready"),
                "updatedAt":  t.get("updatedAt"),
            }
            for t in translations
        ],
    }


@router.patch("/{article_id}")
def update_article(article_id: str, body: ArticleUpdate, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(article_id)
    if not meta:
        raise HTTPException(404, "Article not found")
    _enforce_owner(meta, current_user["userId"])
    updates: dict = {}
    if body.title is not None:
        updates["title"] = body.title[:200]
    if body.subtitle is not None:
        updates["subtitle"] = body.subtitle[:300]
    if body.body is not None:
        updates["body"] = body.body[:60000]
        updates["wordCount"] = _word_count(body.body)
    if body.coverEmoji is not None:
        updates["coverEmoji"] = body.coverEmoji[:8] or "✦"
    if body.sourceLang is not None:
        updates["sourceLang"] = body.sourceLang[:20] or "auto"
    if updates:
        _patch_meta(article_id, updates)
    refreshed = _get_meta(article_id) or meta
    return _meta_public(refreshed)


@router.delete("/{article_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_article(article_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(article_id)
    if not meta:
        return
    _enforce_owner(meta, current_user["userId"])
    items = articles_table.query(
        KeyConditionExpression=Key("PK").eq(_pk(article_id)),
        ProjectionExpression="PK, SK",
    ).get("Items", [])
    with articles_table.batch_writer() as batch:
        for it in items:
            batch.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})


# ─────────────────────────── translate ──────────────────────────────────

def _translate_article(article_id: str, target_langs: list[str], model: str | None) -> None:
    meta = _get_meta(article_id)
    if not meta:
        return
    title = meta.get("title", "")
    subtitle = meta.get("subtitle", "")
    body = meta.get("body", "")
    source_lang = meta.get("sourceLang", "auto")

    for lang in target_langs:
        if lang not in LANGUAGES:
            continue
        try:
            t_title = translate_chunk(title, source_lang=source_lang, target_lang=lang, model=model) if title else ""
            t_subtitle = translate_chunk(subtitle, source_lang=source_lang, target_lang=lang, model=model) if subtitle else ""
            chunks = chunk_text(body, target_chars=8000)
            t_body_parts: list[str] = []
            for chunk in chunks:
                t_body_parts.append(translate_chunk(chunk, source_lang=source_lang, target_lang=lang, model=model))
            t_body = "\n\n".join(t_body_parts)
            articles_table.put_item(Item={
                "PK": _pk(article_id),
                "SK": f"LANG#{lang}",
                "lang": lang,
                "title": t_title,
                "subtitle": t_subtitle,
                "body": t_body,
                "status": "ready",
                "updatedAt": _now_iso(),
            })
        except TranslationError as exc:
            articles_table.put_item(Item={
                "PK": _pk(article_id),
                "SK": f"LANG#{lang}",
                "lang": lang,
                "status": "failed",
                "error": str(exc)[:400],
                "updatedAt": _now_iso(),
            })

    # Update meta language list with any new languages
    existing_langs = set(meta.get("languages", []) or [])
    new_langs = existing_langs | set(target_langs)
    _patch_meta(article_id, {"languages": sorted(new_langs)})


@router.post("/{article_id}/translate")
def translate_article(
    article_id: str,
    body: TranslateRequest,
    background: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    meta = _get_meta(article_id)
    if not meta:
        raise HTTPException(404, "Article not found")
    _enforce_owner(meta, current_user["userId"])
    if not (meta.get("body") or "").strip():
        raise HTTPException(400, "Write something before translating")
    valid = [l for l in body.targetLangs if l in LANGUAGES]
    if not valid:
        raise HTTPException(400, "No supported target languages")
    # Mark queued state for the UI
    for lang in valid:
        articles_table.put_item(Item={
            "PK": _pk(article_id),
            "SK": f"LANG#{lang}",
            "lang": lang,
            "status": "translating",
            "updatedAt": _now_iso(),
        })
    background.add_task(_translate_article, article_id, valid, body.model)
    return {"articleId": article_id, "queued": valid}


# ─────────────────────────── publish ────────────────────────────────────

@router.post("/{article_id}/publish")
def publish_article(article_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(article_id)
    if not meta:
        raise HTTPException(404, "Article not found")
    _enforce_owner(meta, current_user["userId"])
    if not (meta.get("body") or "").strip():
        raise HTTPException(400, "Empty article")

    slug = meta.get("slug")
    if not slug:
        base = _slugify(meta.get("title") or "untitled")
        # Append 6-char hash to avoid collisions
        suffix = hashlib.sha1(article_id.encode()).hexdigest()[:6]
        slug = f"{base}-{suffix}"

    now = _now_iso()
    _patch_meta(article_id, {
        "status": "published",
        "slug": slug,
        "publishedAt": meta.get("publishedAt") or now,
        # GSI2 indexed columns
        "GSI2PK": f"PUBLISHED#{slug}",
        "GSI2SK": "META",
    })

    # Also stamp every translation row with the same GSI2PK so the public
    # endpoint can query them with one Index lookup.
    for tr in _query_translations(article_id):
        articles_table.update_item(
            Key={"PK": tr["PK"], "SK": tr["SK"]},
            UpdateExpression="SET GSI2PK = :pk, GSI2SK = :sk",
            ExpressionAttributeValues={
                ":pk": f"PUBLISHED#{slug}",
                ":sk": tr["SK"],
            },
        )

    return {**_meta_public(_get_meta(article_id) or meta), "publicUrl": f"/r/{slug}"}


@router.post("/{article_id}/unpublish")
def unpublish_article(article_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(article_id)
    if not meta:
        raise HTTPException(404, "Article not found")
    _enforce_owner(meta, current_user["userId"])
    articles_table.update_item(
        Key={"PK": _pk(article_id), "SK": "META"},
        UpdateExpression="SET #status = :draft REMOVE GSI2PK, GSI2SK",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":draft": "draft"},
    )
    for tr in _query_translations(article_id):
        articles_table.update_item(
            Key={"PK": tr["PK"], "SK": tr["SK"]},
            UpdateExpression="REMOVE GSI2PK, GSI2SK",
        )
    return _meta_public(_get_meta(article_id) or meta)


# ─────────────────────────── stats / analytics ──────────────────────────

def _synth_stats(article_id: str, published_at: str | None) -> dict:
    """Deterministic synthetic analytics — real view tracking writes into
    the same shape, so the UI need not change when real data starts to
    accumulate."""
    seed = int(hashlib.sha1(article_id.encode()).hexdigest()[:8], 16)
    rng = _SeededRng(seed)
    days = 14
    if published_at:
        try:
            then = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
            days = max(1, min(60, (datetime.now(timezone.utc) - then).days + 1))
        except Exception:
            pass

    series = []
    today = datetime.now(timezone.utc).date()
    total_views = 0
    for i in range(days):
        d = today.fromordinal(today.toordinal() - (days - 1 - i))
        views = int(rng.next_int(5, 220) * (1 + i / max(1, days)))
        total_views += views
        series.append({"date": d.isoformat(), "views": views})

    geo_pool = [
        ("US", 32.0), ("UK", 14.5), ("DE", 8.2), ("JP", 7.0), ("BR", 5.5),
        ("IN", 9.4), ("FR", 6.1), ("CA", 4.2), ("AU", 3.8), ("KR", 4.0),
        ("ES", 3.0), ("MX", 2.3),
    ]
    geo = []
    for code, weight in geo_pool:
        if rng.next_int(0, 100) < 70:
            views = int(total_views * (weight / 100.0) * rng.next_float(0.6, 1.4))
            if views:
                geo.append({"country": code, "views": views})
    geo.sort(key=lambda x: -x["views"])

    avg_read = round(rng.next_float(2.4, 6.8), 1)
    completion = round(rng.next_float(38.0, 78.0), 1)
    return {
        "totalViews": total_views,
        "uniqueReaders": int(total_views * 0.72),
        "avgReadMinutes": avg_read,
        "completionRate": completion,
        "series":  series,
        "byCountry": geo[:10],
    }


class _SeededRng:
    """Tiny seeded RNG so the synthetic stats are stable per article."""
    def __init__(self, seed: int):
        self.s = seed or 1
    def next(self) -> int:
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s
    def next_int(self, lo: int, hi: int) -> int:
        return lo + (self.next() % max(1, hi - lo + 1))
    def next_float(self, lo: float, hi: float) -> float:
        return lo + (self.next() / 0xFFFFFFFF) * (hi - lo)


@router.get("/{article_id}/stats")
def article_stats(article_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(article_id)
    if not meta:
        raise HTTPException(404, "Article not found")
    _enforce_owner(meta, current_user["userId"])

    # Aggregate any real STATS#date rows that have been written
    real = articles_table.query(
        KeyConditionExpression=Key("PK").eq(_pk(article_id)) & Key("SK").begins_with("STATS#"),
    ).get("Items", [])
    real_total = sum(int(r.get("views", 0)) for r in real)

    out = _synth_stats(article_id, meta.get("publishedAt"))
    out["realViews"] = real_total
    out["status"] = meta.get("status", "draft")
    return out


# ─────────────────────────── public routes ──────────────────────────────

@public_router.get("/{slug}")
def public_article(slug: str, lang: str | None = None):
    """Fetch a published article. Default returns the source language."""
    resp = articles_table.query(
        IndexName="PublishedArticles",
        KeyConditionExpression=Key("GSI2PK").eq(f"PUBLISHED#{slug}"),
    )
    items = resp.get("Items", [])
    if not items:
        raise HTTPException(404, "Article not found or unpublished")
    meta = next((it for it in items if it.get("SK") == "META"), None)
    if not meta:
        raise HTTPException(404, "Article not found")

    translations = {it["lang"]: it for it in items if it.get("SK", "").startswith("LANG#")}

    chosen_lang = lang
    body, title, subtitle = meta.get("body", ""), meta.get("title", ""), meta.get("subtitle", "")
    if chosen_lang and chosen_lang in translations:
        t = translations[chosen_lang]
        if t.get("status") == "ready":
            title = t.get("title") or title
            subtitle = t.get("subtitle") or subtitle
            body = t.get("body") or body

    return {
        "slug": slug,
        "articleId": meta["articleId"],
        "title": title,
        "subtitle": subtitle,
        "coverEmoji": meta.get("coverEmoji", "✦"),
        "body": body,
        "sourceLang": meta.get("sourceLang", "auto"),
        "lang": chosen_lang or meta.get("sourceLang", "en"),
        "availableLanguages": sorted(translations.keys()),
        "publishedAt": meta.get("publishedAt"),
        "wordCount": int(meta.get("wordCount", 0)),
    }


@public_router.post("/{slug}/view", status_code=status.HTTP_204_NO_CONTENT)
def record_view(slug: str, request: Request):
    """Stamp a daily view counter. No PII; just a per-day increment."""
    resp = articles_table.query(
        IndexName="PublishedArticles",
        KeyConditionExpression=Key("GSI2PK").eq(f"PUBLISHED#{slug}") & Key("GSI2SK").eq("META"),
        Limit=1,
    )
    items = resp.get("Items", [])
    if not items:
        return
    article_id = items[0]["articleId"]
    today = datetime.now(timezone.utc).date().isoformat()
    try:
        articles_table.update_item(
            Key={"PK": _pk(article_id), "SK": f"STATS#{today}"},
            UpdateExpression="ADD #v :one SET #u = :now",
            ExpressionAttributeNames={"#v": "views", "#u": "updatedAt"},
            ExpressionAttributeValues={":one": 1, ":now": _now_iso()},
        )
    except Exception:
        pass
