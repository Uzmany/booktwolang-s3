"""Idempotently create the DynamoDB tables BookTwoLang needs for the
extended product surface (Nexus / Vault / Broadcast).

Run once per environment:

    AWS_REGION=us-east-1 python3 scripts/create_tables.py

Existing tables (booktwolang_documents, booktwolang_UserProfiles,
booktwolang_UserSessions) are NOT touched; this only adds the new ones.
"""
from __future__ import annotations

import os
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.getenv("AWS_REGION", "us-east-1")
dynamodb = boto3.client("dynamodb", region_name=REGION)


def _exists(name: str) -> bool:
    try:
        dynamodb.describe_table(TableName=name)
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ResourceNotFoundException":
            return False
        raise


def _wait(name: str) -> None:
    print(f"  waiting for {name}…", end="", flush=True)
    waiter = dynamodb.get_waiter("table_exists")
    waiter.wait(TableName=name, WaiterConfig={"Delay": 3, "MaxAttempts": 30})
    print(" ready.")


def create_canvases() -> None:
    name = "booktwolang_canvases"
    if _exists(name):
        print(f"[skip] {name} already exists.")
        return
    print(f"[create] {name}")
    dynamodb.create_table(
        TableName=name,
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
            {"AttributeName": "GSI1PK", "AttributeType": "S"},
            {"AttributeName": "GSI1SK", "AttributeType": "S"},
        ],
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "UserCanvases",
                "KeySchema": [
                    {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                    {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
    )
    _wait(name)


def create_journal() -> None:
    name = "booktwolang_journal"
    if _exists(name):
        print(f"[skip] {name} already exists.")
        return
    print(f"[create] {name}")
    dynamodb.create_table(
        TableName=name,
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
    )
    _wait(name)


def create_articles() -> None:
    name = "booktwolang_articles"
    if _exists(name):
        print(f"[skip] {name} already exists.")
        return
    print(f"[create] {name}")
    dynamodb.create_table(
        TableName=name,
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
            {"AttributeName": "GSI1PK", "AttributeType": "S"},
            {"AttributeName": "GSI1SK", "AttributeType": "S"},
            {"AttributeName": "GSI2PK", "AttributeType": "S"},
            {"AttributeName": "GSI2SK", "AttributeType": "S"},
        ],
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "UserArticles",
                "KeySchema": [
                    {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                    {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
            {
                "IndexName": "PublishedArticles",
                "KeySchema": [
                    {"AttributeName": "GSI2PK", "KeyType": "HASH"},
                    {"AttributeName": "GSI2SK", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
    )
    _wait(name)


def main() -> None:
    print(f"Region: {REGION}")
    create_canvases()
    create_journal()
    create_articles()
    print("Done.")


if __name__ == "__main__":
    main()
