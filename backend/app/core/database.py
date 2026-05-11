from __future__ import annotations

from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import BACKEND_DIR, settings
from app.models.base import Base
from app.models.user import User
from app.models.vote import Vote


def _resolved_database_url() -> URL:
    url = make_url(settings.database_url)
    if url.get_backend_name() != "sqlite" or not url.database:
        return url

    sqlite_path = Path(url.database)
    if sqlite_path.is_absolute():
        return url

    absolute_path = (BACKEND_DIR / sqlite_path).resolve()
    return url.set(database=str(absolute_path))


DATABASE_URL = _resolved_database_url()
engine = create_async_engine(DATABASE_URL, future=True, pool_pre_ping=True)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
IS_SQLITE = DATABASE_URL.get_backend_name() == "sqlite"

_ = (User, Vote)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session


async def init_db() -> None:
    async with engine.begin() as conn:
        if not IS_SQLITE:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))

        # Temporary hard reset to rebuild schema with all current model columns.
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
