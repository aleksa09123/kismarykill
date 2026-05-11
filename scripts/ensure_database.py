from __future__ import annotations

import asyncio
import os
import sys

import asyncpg
from sqlalchemy.engine import make_url

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "backend")
if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

from app.core.config import settings  # noqa: E402


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


async def ensure_database_exists() -> None:
    db_url = make_url(settings.database_url)
    target_db_name = db_url.database or "kismarykill"
    admin_db_name = os.getenv("POSTGRES_ADMIN_DB", "postgres")

    try:
        connection = await asyncpg.connect(
            user=db_url.username or "postgres",
            password=db_url.password or "",
            host=db_url.host or "localhost",
            port=db_url.port or 5432,
            database=admin_db_name,
        )
    except Exception as exc:
        print(
            "Could not connect to PostgreSQL admin database "
            f"'{admin_db_name}' on {db_url.host or 'localhost'}:{db_url.port or 5432}. "
            "Start PostgreSQL and verify DATABASE_URL credentials first."
        )
        raise SystemExit(1) from exc

    try:
        exists = await connection.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            target_db_name,
        )
        if exists:
            print(f"Database '{target_db_name}' already exists.")
            return

        await connection.execute(f"CREATE DATABASE {_quote_identifier(target_db_name)}")
        print(f"Database '{target_db_name}' created successfully.")
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(ensure_database_exists())
