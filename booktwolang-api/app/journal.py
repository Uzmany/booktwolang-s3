"""Vault journal API — distraction-free entries with auto-tagging and a
memory-surface that resurrects past entries.

DynamoDB layout (table ``booktwolang_journal``):

    PK = USER#{userId}
    SK = ENTRY#{ISO timestamp}#{entryId}

The SK ordering is naturally chronological, so a single Query with
``ScanIndexForward=False`` and an ``SK BETWEEN`` filter handles every
calendar lookup the UI needs.
"""
from __future__ import annotations

import os
import random
import re
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from .ai import AIError, gemini_json
from .users import get_current_user

REGION = os.getenv("AWS_REGION", "us-east-1")
_dynamodb = boto3.resource("dynamodb", region_name=REGION)
journal_table = _dynamodb.Table("booktwolang_journal")

router = APIRouter(prefix="/v1/journal", tags=["journal"])


# ─────────────────────────── helpers ────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _pk(user_id: str) -> str:
    return f"USER#{user_id}"

def _sk(iso: str, entry_id: str) -> str:
    return f"ENTRY#{iso}#{entry_id}"

def _public(item: dict) -> dict:
    return {
        "entryId":   item["entryId"],
        "title":     item.get("title", ""),
        "body":      item.get("body", ""),
        "mood":      item.get("mood"),
        "tags":      list(item.get("tags", []) or []),
        "wordCount": int(item.get("wordCount", 0)),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }

def _count_words(text: str) -> int:
    return len([w for w in re.split(r"\s+", text or "") if w])


def _auto_tag(text: str) -> tuple[list[str], str | None, str | None]:
    """Ask Gemini for tags + mood + suggested title. Best-effort; failures
    return empty results."""
    if _count_words(text) < 35:
        return [], None, None
    system = (
        "You are a quiet journal indexer. Given a free-form journal entry, "
        "return strict JSON with three fields:\n"
        '  "tags":  array of 2-6 lowercase single-word or two-word tags '
        '(e.g. "trading", "noor", "morning-run", "anxiety", "gratitude")\n'
        '  "mood":  one of "calm", "focused", "anxious", "elated", "tender",'
        '          "frustrated", "grieving", "grateful", or null\n'
        '  "title": optional short (≤7 words) descriptive title for the entry\n'
        "Output ONLY valid JSON, no commentary."
    )
    try:
        data = gemini_json(system=system, user=text[:6000], temperature=0.3)
    except AIError:
        return [], None, None
    if not isinstance(data, dict):
        return [], None, None
    tags = [str(t).lower().strip()[:32] for t in (data.get("tags") or []) if t]
    tags = [t for t in tags if t and len(t) <= 32][:8]
    mood = data.get("mood")
    if mood not in {"calm", "focused", "anxious", "elated", "tender", "frustrated", "grieving", "grateful"}:
        mood = None
    title = data.get("title")
    if isinstance(title, str):
        title = title.strip()[:120] or None
    else:
        title = None
    return tags, mood, title


# ─────────────────────────── request bodies ─────────────────────────────

class EntryCreate(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    body:  str = Field(min_length=1, max_length=40000)
    mood:  str | None = Field(default=None, max_length=20)
    tags:  list[str] | None = None
    autotag: bool = True


class EntryUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    body:  str | None = Field(default=None, max_length=40000)
    mood:  str | None = Field(default=None, max_length=20)
    tags:  list[str] | None = None
    retag: bool = False


# ──────────────────────────── routes ────────────────────────────────────

@router.get("/entries")
def list_entries(
    from_: str | None = Query(default=None, alias="from"),
    to:    str | None = Query(default=None, alias="to"),
    tag:   str | None = None,
    limit: int = Query(default=60, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
):
    kc = Key("PK").eq(_pk(current_user["userId"]))
    if from_ and to:
        kc = kc & Key("SK").between(f"ENTRY#{from_}", f"ENTRY#{to}#~")
    elif from_:
        kc = kc & Key("SK").gte(f"ENTRY#{from_}")
    elif to:
        kc = kc & Key("SK").lte(f"ENTRY#{to}#~")
    else:
        kc = kc & Key("SK").begins_with("ENTRY#")

    items: list[dict] = []
    kwargs = {
        "KeyConditionExpression": kc,
        "ScanIndexForward": False,
        "Limit": limit,
    }
    resp = journal_table.query(**kwargs)
    for it in resp.get("Items", []):
        if tag and tag not in (it.get("tags") or []):
            continue
        items.append(_public(it))
    return {"entries": items}


@router.post("/entries", status_code=status.HTTP_201_CREATED)
def create_entry(
    body: EntryCreate,
    background: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    entry_id = uuid.uuid4().hex[:12]
    now = _now_iso()
    tags = [str(t).lower().strip()[:32] for t in (body.tags or []) if t][:8]
    mood = (body.mood or "").lower().strip() or None
    title = (body.title or "").strip()[:120] or None

    item = {
        "PK": _pk(current_user["userId"]),
        "SK": _sk(now, entry_id),
        "entryId": entry_id,
        "title": title or "",
        "body": body.body,
        "mood": mood,
        "tags": tags,
        "wordCount": _count_words(body.body),
        "createdAt": now,
        "updatedAt": now,
    }
    journal_table.put_item(Item=item)

    # Auto-tag in the background so the user doesn't wait for Gemini.
    if body.autotag and (not tags or not mood or not title):
        def _bg_tag():
            ai_tags, ai_mood, ai_title = _auto_tag(body.body)
            merged_tags = sorted(set(tags) | set(ai_tags))[:10]
            updates: dict = {"tags": merged_tags}
            if not mood and ai_mood:
                updates["mood"] = ai_mood
            if not title and ai_title:
                updates["title"] = ai_title
            if updates:
                _patch_item(current_user["userId"], _sk(now, entry_id), updates)
        background.add_task(_bg_tag)

    return _public(item)


def _patch_item(user_id: str, sk: str, updates: dict) -> None:
    expr = ["#updatedAt = :updatedAt"]
    names: dict = {"#updatedAt": "updatedAt"}
    values: dict = {":updatedAt": _now_iso()}
    for i, (k, v) in enumerate(updates.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = v
        expr.append(f"#k{i} = :v{i}")
    journal_table.update_item(
        Key={"PK": _pk(user_id), "SK": sk},
        UpdateExpression="SET " + ", ".join(expr),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _find_by_id(user_id: str, entry_id: str) -> dict | None:
    """Entries are written with SK = ENTRY#{iso}#{entryId}; for a small per-
    user journal, scanning the last ~200 entries client-side is cheap and
    avoids needing a second GSI."""
    items: list[dict] = []
    kwargs = {
        "KeyConditionExpression": Key("PK").eq(_pk(user_id)) & Key("SK").begins_with("ENTRY#"),
        "ScanIndexForward": False,
        "Limit": 200,
    }
    while True:
        resp = journal_table.query(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp or len(items) >= 1000:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    for it in items:
        if it.get("entryId") == entry_id:
            return it
    return None


@router.get("/entries/{entry_id}")
def get_entry(entry_id: str, current_user: dict = Depends(get_current_user)):
    item = _find_by_id(current_user["userId"], entry_id)
    if not item:
        raise HTTPException(404, "Entry not found")
    return _public(item)


@router.patch("/entries/{entry_id}")
def update_entry(
    entry_id: str,
    body: EntryUpdate,
    background: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    item = _find_by_id(current_user["userId"], entry_id)
    if not item:
        raise HTTPException(404, "Entry not found")

    updates: dict = {}
    if body.title is not None:
        updates["title"] = body.title[:120]
    if body.body is not None:
        updates["body"] = body.body
        updates["wordCount"] = _count_words(body.body)
    if body.mood is not None:
        updates["mood"] = body.mood[:20].lower() or None
    if body.tags is not None:
        updates["tags"] = [str(t).lower().strip()[:32] for t in body.tags if t][:10]
    if updates:
        _patch_item(current_user["userId"], item["SK"], updates)

    if body.retag and body.body:
        def _bg_retag():
            ai_tags, ai_mood, ai_title = _auto_tag(body.body)
            merged: dict = {}
            if ai_tags:
                existing = set(updates.get("tags", item.get("tags") or []))
                merged["tags"] = sorted(existing | set(ai_tags))[:10]
            if ai_mood and not (body.mood or item.get("mood")):
                merged["mood"] = ai_mood
            if ai_title and not (body.title or item.get("title")):
                merged["title"] = ai_title
            if merged:
                _patch_item(current_user["userId"], item["SK"], merged)
        background.add_task(_bg_retag)

    refreshed = _find_by_id(current_user["userId"], entry_id)
    return _public(refreshed or item)


@router.delete("/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(entry_id: str, current_user: dict = Depends(get_current_user)):
    item = _find_by_id(current_user["userId"], entry_id)
    if not item:
        return
    journal_table.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})


@router.get("/tags")
def list_tags(current_user: dict = Depends(get_current_user)):
    resp = journal_table.query(
        KeyConditionExpression=Key("PK").eq(_pk(current_user["userId"])) & Key("SK").begins_with("ENTRY#"),
        ProjectionExpression="tags",
    )
    counts: dict[str, int] = {}
    for it in resp.get("Items", []):
        for t in (it.get("tags") or []):
            counts[t] = counts.get(t, 0) + 1
    top = sorted(counts.items(), key=lambda x: -x[1])
    return {"tags": [{"tag": t, "count": c} for t, c in top]}


@router.get("/surface")
def memory_surface(current_user: dict = Depends(get_current_user)):
    """Return up to three past entries to gently surface — an anniversary
    entry (~1y ago), a thematically-tagged entry, and a random older one.
    Empty arrays are fine when the journal is young."""
    user_id = current_user["userId"]
    resp = journal_table.query(
        KeyConditionExpression=Key("PK").eq(_pk(user_id)) & Key("SK").begins_with("ENTRY#"),
        ScanIndexForward=False,
        Limit=200,
    )
    items = resp.get("Items", [])
    if not items:
        return {"surfaces": []}

    now = datetime.now(timezone.utc)
    anniversaries = []
    older = []
    for it in items:
        try:
            created = datetime.fromisoformat(it["createdAt"].replace("Z", "+00:00"))
        except Exception:
            continue
        age_days = (now - created).days
        if 350 <= age_days <= 380:
            anniversaries.append((it, age_days, "Look back at this from a year ago"))
        elif age_days >= 14:
            older.append((it, age_days, None))

    surfaces: list[dict] = []
    for it, days, reason in anniversaries[:1]:
        surfaces.append({
            "reason": reason or f"From {days} days ago",
            "entry":  _public(it),
        })
    if older:
        it, days, _ = random.choice(older)
        surfaces.append({
            "reason": f"From {days} days ago",
            "entry":  _public(it),
        })
        # Look for another older one with overlapping tags to a recent entry
        recent_tags = set()
        for it_r in items[:5]:
            recent_tags |= set(it_r.get("tags") or [])
        themed = [
            (o_it, days, list(set(o_it.get("tags") or []) & recent_tags))
            for o_it, days, _ in older
            if set(o_it.get("tags") or []) & recent_tags and o_it.get("entryId") != it.get("entryId")
        ]
        if themed:
            t_it, t_days, t_tags = random.choice(themed)
            surfaces.append({
                "reason": f"You wrote about #{t_tags[0]} {t_days} days ago",
                "entry":  _public(t_it),
            })
    return {"surfaces": surfaces[:3]}
