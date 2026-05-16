"""Nexus canvas API — boards, nodes, edges, and agentic compile.

DynamoDB layout (table ``booktwolang_canvases``):

    PK = CANVAS#{id}
    SK in {META, NODE#{nid}, EDGE#{eid}}

    GSI1 (UserCanvases)
        GSI1PK = USER#{userId}
        GSI1SK = createdAt
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .ai import AIError, gemini_complete
from .users import get_current_user


def _dec(v) -> Decimal:
    """boto3's DynamoDB resource rejects Python floats — coordinates must
    round-trip through ``Decimal``. We go via ``str`` to avoid binary-fp
    surprises."""
    if v is None:
        return Decimal("0")
    return Decimal(str(v))

REGION = os.getenv("AWS_REGION", "us-east-1")
_dynamodb = boto3.resource("dynamodb", region_name=REGION)
canvases_table = _dynamodb.Table("booktwolang_canvases")

router = APIRouter(prefix="/v1/canvases", tags=["canvas"])


# ───────────────────────────── helpers ──────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _pk(canvas_id: str) -> str:
    return f"CANVAS#{canvas_id}"

def _enforce_owner(meta: dict, user_id: str) -> None:
    if meta.get("ownerId") != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your canvas")

def _meta_public(item: dict) -> dict:
    return {
        "canvasId": item["canvasId"],
        "title": item.get("title", "Untitled canvas"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
        "nodeCount": int(item.get("nodeCount", 0)),
        "edgeCount": int(item.get("edgeCount", 0)),
    }

def _node_public(item: dict) -> dict:
    return {
        "nodeId":  item["nodeId"],
        "type":    item.get("type", "text"),
        "x":       float(item.get("x", 0)),
        "y":       float(item.get("y", 0)),
        "w":       float(item.get("w", 240)),
        "h":       float(item.get("h", 140)),
        "title":   item.get("title", ""),
        "content": item.get("content", ""),
        "accent":  item.get("accent", "gold"),
        "createdAt": item.get("createdAt"),
    }

def _edge_public(item: dict) -> dict:
    return {
        "edgeId": item["edgeId"],
        "from":   item["fromNodeId"],
        "to":     item["toNodeId"],
        "label":  item.get("label", ""),
    }

def _get_meta(canvas_id: str) -> dict | None:
    return canvases_table.get_item(Key={"PK": _pk(canvas_id), "SK": "META"}).get("Item")

def _query_all(canvas_id: str, prefix: str) -> list[dict]:
    out: list[dict] = []
    kwargs = {"KeyConditionExpression": Key("PK").eq(_pk(canvas_id)) & Key("SK").begins_with(prefix)}
    while True:
        resp = canvases_table.query(**kwargs)
        out.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return out

def _update_meta(canvas_id: str, updates: dict) -> None:
    expr = ["#updatedAt = :updatedAt"]
    names = {"#updatedAt": "updatedAt"}
    values = {":updatedAt": _now_iso()}
    for i, (k, v) in enumerate(updates.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = v
        expr.append(f"#k{i} = :v{i}")
    canvases_table.update_item(
        Key={"PK": _pk(canvas_id), "SK": "META"},
        UpdateExpression="SET " + ", ".join(expr),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


# ─────────────────────────── request bodies ─────────────────────────────

class CanvasCreate(BaseModel):
    title: str = Field(default="Untitled canvas", max_length=200)

class CanvasUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)

class NodeCreate(BaseModel):
    type:    str = Field(default="text", max_length=40)
    x:       float = 0
    y:       float = 0
    w:       float = 240
    h:       float = 140
    title:   str = Field(default="", max_length=120)
    content: str = Field(default="", max_length=8000)
    accent:  str = Field(default="gold", max_length=20)

class NodeUpdate(BaseModel):
    x:       float | None = None
    y:       float | None = None
    w:       float | None = None
    h:       float | None = None
    title:   str | None = Field(default=None, max_length=120)
    content: str | None = Field(default=None, max_length=8000)
    accent:  str | None = Field(default=None, max_length=20)

class EdgeCreate(BaseModel):
    fromNodeId: str
    toNodeId:   str
    label:      str = Field(default="", max_length=80)


# ────────────────────────── canvas-level routes ─────────────────────────

@router.get("")
def list_canvases(current_user: dict = Depends(get_current_user)):
    resp = canvases_table.query(
        IndexName="UserCanvases",
        KeyConditionExpression=Key("GSI1PK").eq(f"USER#{current_user['userId']}"),
        ScanIndexForward=False,
        Limit=100,
    )
    items = [_meta_public(it) for it in resp.get("Items", []) if it.get("SK") == "META"]
    return {"canvases": items}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_canvas(body: CanvasCreate, current_user: dict = Depends(get_current_user)):
    canvas_id = uuid.uuid4().hex
    now = _now_iso()
    item = {
        "PK": _pk(canvas_id),
        "SK": "META",
        "canvasId": canvas_id,
        "ownerId": current_user["userId"],
        "title": body.title[:200],
        "createdAt": now,
        "updatedAt": now,
        "nodeCount": 0,
        "edgeCount": 0,
        "GSI1PK": f"USER#{current_user['userId']}",
        "GSI1SK": now,
    }
    canvases_table.put_item(Item=item)
    return _meta_public(item)


@router.get("/{canvas_id}")
def get_canvas(canvas_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        raise HTTPException(404, "Canvas not found")
    _enforce_owner(meta, current_user["userId"])
    nodes = [_node_public(it) for it in _query_all(canvas_id, "NODE#")]
    edges = [_edge_public(it) for it in _query_all(canvas_id, "EDGE#")]
    return {**_meta_public(meta), "nodes": nodes, "edges": edges}


@router.patch("/{canvas_id}")
def update_canvas(canvas_id: str, body: CanvasUpdate, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        raise HTTPException(404, "Canvas not found")
    _enforce_owner(meta, current_user["userId"])
    updates = {}
    if body.title is not None:
        updates["title"] = body.title[:200]
    if updates:
        _update_meta(canvas_id, updates)
    return _meta_public({**meta, **updates})


@router.delete("/{canvas_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_canvas(canvas_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        return
    _enforce_owner(meta, current_user["userId"])
    items = canvases_table.query(
        KeyConditionExpression=Key("PK").eq(_pk(canvas_id)),
        ProjectionExpression="PK, SK",
    ).get("Items", [])
    with canvases_table.batch_writer() as batch:
        for it in items:
            batch.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})


# ──────────────────────────── node routes ───────────────────────────────

@router.post("/{canvas_id}/nodes", status_code=status.HTTP_201_CREATED)
def create_node(canvas_id: str, body: NodeCreate, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        raise HTTPException(404, "Canvas not found")
    _enforce_owner(meta, current_user["userId"])
    node_id = uuid.uuid4().hex
    now = _now_iso()
    item = {
        "PK": _pk(canvas_id),
        "SK": f"NODE#{node_id}",
        "nodeId": node_id,
        "type": body.type[:40],
        "x": _dec(body.x),
        "y": _dec(body.y),
        "w": _dec(body.w),
        "h": _dec(body.h),
        "title": body.title[:120],
        "content": body.content[:8000],
        "accent": body.accent[:20],
        "createdAt": now,
    }
    canvases_table.put_item(Item=item)
    _update_meta(canvas_id, {"nodeCount": int(meta.get("nodeCount", 0)) + 1})
    return _node_public(item)


@router.patch("/{canvas_id}/nodes/{node_id}")
def update_node(canvas_id: str, node_id: str, body: NodeUpdate, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        raise HTTPException(404, "Canvas not found")
    _enforce_owner(meta, current_user["userId"])
    existing = canvases_table.get_item(Key={"PK": _pk(canvas_id), "SK": f"NODE#{node_id}"}).get("Item")
    if not existing:
        raise HTTPException(404, "Node not found")

    updates: dict = {}
    for field in ("x", "y", "w", "h"):
        val = getattr(body, field)
        if val is not None:
            updates[field] = _dec(val)
    for field in ("title", "content", "accent"):
        val = getattr(body, field)
        if val is not None:
            updates[field] = str(val)[:120 if field == "title" else 8000 if field == "content" else 20]
    if not updates:
        return _node_public(existing)

    expr = []
    names: dict = {}
    values: dict = {}
    for i, (k, v) in enumerate(updates.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = v
        expr.append(f"#k{i} = :v{i}")
    canvases_table.update_item(
        Key={"PK": _pk(canvas_id), "SK": f"NODE#{node_id}"},
        UpdateExpression="SET " + ", ".join(expr),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    _update_meta(canvas_id, {})
    refreshed = canvases_table.get_item(Key={"PK": _pk(canvas_id), "SK": f"NODE#{node_id}"}).get("Item")
    return _node_public(refreshed or existing)


@router.delete("/{canvas_id}/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(canvas_id: str, node_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        return
    _enforce_owner(meta, current_user["userId"])
    canvases_table.delete_item(Key={"PK": _pk(canvas_id), "SK": f"NODE#{node_id}"})
    # Also delete any edges that touch this node
    edges = _query_all(canvas_id, "EDGE#")
    for e in edges:
        if e.get("fromNodeId") == node_id or e.get("toNodeId") == node_id:
            canvases_table.delete_item(Key={"PK": _pk(canvas_id), "SK": e["SK"]})
    new_node_count = max(0, int(meta.get("nodeCount", 0)) - 1)
    _update_meta(canvas_id, {"nodeCount": new_node_count})


# ──────────────────────────── edge routes ───────────────────────────────

@router.post("/{canvas_id}/edges", status_code=status.HTTP_201_CREATED)
def create_edge(canvas_id: str, body: EdgeCreate, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        raise HTTPException(404, "Canvas not found")
    _enforce_owner(meta, current_user["userId"])
    edge_id = uuid.uuid4().hex
    item = {
        "PK": _pk(canvas_id),
        "SK": f"EDGE#{edge_id}",
        "edgeId": edge_id,
        "fromNodeId": body.fromNodeId,
        "toNodeId":   body.toNodeId,
        "label": body.label[:80],
        "createdAt": _now_iso(),
    }
    canvases_table.put_item(Item=item)
    _update_meta(canvas_id, {"edgeCount": int(meta.get("edgeCount", 0)) + 1})
    return _edge_public(item)


@router.delete("/{canvas_id}/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge(canvas_id: str, edge_id: str, current_user: dict = Depends(get_current_user)):
    meta = _get_meta(canvas_id)
    if not meta:
        return
    _enforce_owner(meta, current_user["userId"])
    canvases_table.delete_item(Key={"PK": _pk(canvas_id), "SK": f"EDGE#{edge_id}"})
    _update_meta(canvas_id, {"edgeCount": max(0, int(meta.get("edgeCount", 0)) - 1)})


# ──────────────────────────── agentic compile ───────────────────────────

@router.post("/{canvas_id}/compile")
def compile_canvas(canvas_id: str, current_user: dict = Depends(get_current_user)):
    """Send the node-graph to Gemini and ask it to produce a structured
    outline + a short first-draft of the cohesive document."""
    meta = _get_meta(canvas_id)
    if not meta:
        raise HTTPException(404, "Canvas not found")
    _enforce_owner(meta, current_user["userId"])
    nodes = _query_all(canvas_id, "NODE#")
    edges = _query_all(canvas_id, "EDGE#")
    if not nodes:
        raise HTTPException(400, "Add some nodes to the canvas first")

    nodes_text_blocks = []
    id_to_idx = {}
    for i, n in enumerate(nodes, start=1):
        id_to_idx[n["nodeId"]] = i
        title = (n.get("title") or "").strip() or "(untitled)"
        content = (n.get("content") or "").strip()
        nodes_text_blocks.append(f"NODE {i}  [{title}]\n{content or '(empty)'}")

    edge_lines = []
    for e in edges:
        a = id_to_idx.get(e["fromNodeId"])
        b = id_to_idx.get(e["toNodeId"])
        if a and b:
            label = f" — {e.get('label')}" if e.get("label") else ""
            edge_lines.append(f"NODE {a} → NODE {b}{label}")

    user_prompt = (
        "TITLE: " + (meta.get("title") or "Untitled") + "\n\n"
        "NODES:\n" + "\n\n".join(nodes_text_blocks) + "\n\n"
        "CONNECTIONS:\n" + ("\n".join(edge_lines) or "(none)") + "\n"
    )
    system_prompt = (
        "You are a literary editor turning a writer's scattered notes into a "
        "coherent document. You are given a set of NODES (each with a title "
        "and a body) and CONNECTIONS between them describing the writer's "
        "intended flow. Produce a JSON response with two keys:\n"
        '  "outline": an array of objects {"heading": str, "summary": str}\n'
        '             that lay out the document in linear order, respecting '
        "the connections.\n"
        '  "draft":   a single Markdown string — a polished first draft of '
        "the whole document, weaving the node contents together with smooth "
        "transitions and clear section breaks (use #, ##, etc.).\n"
        "Output ONLY valid JSON, no commentary."
    )

    try:
        from .ai import gemini_json
        result = gemini_json(system=system_prompt, user=user_prompt, model=os.getenv("GEMINI_MODEL_PRO", "gemini-3-pro-preview"), temperature=0.5)
    except AIError as exc:
        raise HTTPException(502, f"Compile failed: {exc}")

    outline = result.get("outline") if isinstance(result, dict) else None
    draft = result.get("draft") if isinstance(result, dict) else None
    if not outline or not draft:
        raise HTTPException(502, "Compile produced an incomplete response")

    return {
        "canvasId": canvas_id,
        "compiledAt": _now_iso(),
        "outline": outline,
        "draft": draft,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
    }
