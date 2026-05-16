"""Authentication + user profile routes for BookTwoLang.

Bearer-token only (no refresh cookie). Access tokens last 24 hours. Sessions
are persisted to DynamoDB so they can be revoked on logout.
"""

from __future__ import annotations

import os
import secrets
import time
import uuid
from datetime import datetime, timezone

import boto3
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

REGION = os.getenv("AWS_REGION", "us-east-1")
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ISSUER = "booktwolang-api"
JWT_AUDIENCE = "booktwolang-client"
ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24

_dynamodb = boto3.resource("dynamodb", region_name=REGION)
profiles_table = _dynamodb.Table("booktwolang_UserProfiles")
sessions_table = _dynamodb.Table("booktwolang_UserSessions")
hasher = PasswordHasher()

router = APIRouter(prefix="/v1", tags=["users"])


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    displayName: str | None = Field(default=None, max_length=80)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UpdateProfileRequest(BaseModel):
    displayName: str | None = Field(default=None, max_length=80)
    preferredTargetLang: str | None = Field(default=None, max_length=20)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _issue_access_token(user_id: str, email: str, session_id: str) -> str:
    now = int(time.time())
    payload = {
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "sub": user_id,
        "email": email,
        "sid": session_id,
        "jti": uuid.uuid4().hex,
        "iat": now,
        "nbf": now,
        "exp": now + ACCESS_TOKEN_TTL_SECONDS,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def _create_session(user_id: str) -> str:
    session_id = uuid.uuid4().hex
    sessions_table.put_item(
        Item={
            "sessionId": session_id,
            "userId": user_id,
            "createdAt": _now_iso(),
            "lastUsedAt": _now_iso(),
            "ttl": int(time.time()) + ACCESS_TOKEN_TTL_SECONDS,
        }
    )
    return session_id


def _profile_to_public(item: dict) -> dict:
    return {
        "userId": item["userId"],
        "email": item["email"],
        "displayName": item.get("displayName", ""),
        "preferredTargetLang": item.get("preferredTargetLang", "es"),
        "createdAt": item.get("createdAt"),
    }


def get_current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=["HS256"],
            audience=JWT_AUDIENCE,
            issuer=JWT_ISSUER,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}")

    user_id = payload["sub"]
    session_id = payload.get("sid")
    if session_id:
        try:
            session = sessions_table.get_item(Key={"sessionId": session_id}).get("Item")
        except ClientError as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc))
        if not session:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session revoked")

    try:
        item = profiles_table.get_item(Key={"userId": user_id}).get("Item")
    except ClientError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc))
    if not item:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return item


@router.post("/users", status_code=status.HTTP_201_CREATED)
def signup(body: SignupRequest):
    email_norm = body.email.strip().lower()

    existing = profiles_table.query(
        IndexName="email-index",
        KeyConditionExpression=Key("email").eq(email_norm),
        Limit=1,
    ).get("Items", [])
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")

    user_id = uuid.uuid4().hex
    password_hash = hasher.hash(body.password)
    item = {
        "userId": user_id,
        "email": email_norm,
        "displayName": (body.displayName or email_norm.split("@")[0])[:80],
        "passwordHash": password_hash,
        "preferredTargetLang": "es",
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }
    profiles_table.put_item(Item=item)

    session_id = _create_session(user_id)
    token = _issue_access_token(user_id, email_norm, session_id)
    return {"accessToken": token, "user": _profile_to_public(item)}


@router.post("/auth/login")
def login(body: LoginRequest):
    email_norm = body.email.strip().lower()
    items = profiles_table.query(
        IndexName="email-index",
        KeyConditionExpression=Key("email").eq(email_norm),
        Limit=1,
    ).get("Items", [])
    if not items:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    user = items[0]
    try:
        hasher.verify(user["passwordHash"], body.password)
    except VerifyMismatchError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    session_id = _create_session(user["userId"])
    token = _issue_access_token(user["userId"], user["email"], session_id)
    return {"accessToken": token, "user": _profile_to_public(user)}


@router.post("/auth/logout")
def logout(current_user: dict = Depends(get_current_user), authorization: str = Header(default="")):
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=["HS256"],
            audience=JWT_AUDIENCE,
            issuer=JWT_ISSUER,
        )
    except jwt.PyJWTError:
        return {"ok": True}
    session_id = payload.get("sid")
    if session_id:
        try:
            sessions_table.delete_item(Key={"sessionId": session_id})
        except ClientError:
            pass
    return {"ok": True}


@router.get("/users/me")
def me(current_user: dict = Depends(get_current_user)):
    return _profile_to_public(current_user)


@router.patch("/users/me")
def update_me(body: UpdateProfileRequest, current_user: dict = Depends(get_current_user)):
    updates: dict[str, str] = {}
    if body.displayName is not None:
        updates["displayName"] = body.displayName[:80]
    if body.preferredTargetLang is not None:
        updates["preferredTargetLang"] = body.preferredTargetLang[:20]
    if not updates:
        return _profile_to_public(current_user)

    expr_parts = []
    values: dict[str, str] = {":updatedAt": _now_iso()}
    names: dict[str, str] = {"#updatedAt": "updatedAt"}
    for i, (key, value) in enumerate(updates.items()):
        placeholder_name = f"#k{i}"
        placeholder_val = f":v{i}"
        names[placeholder_name] = key
        values[placeholder_val] = value
        expr_parts.append(f"{placeholder_name} = {placeholder_val}")
    expr_parts.append("#updatedAt = :updatedAt")

    profiles_table.update_item(
        Key={"userId": current_user["userId"]},
        UpdateExpression="SET " + ", ".join(expr_parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    refreshed = profiles_table.get_item(Key={"userId": current_user["userId"]}).get("Item") or {}
    return _profile_to_public(refreshed)
