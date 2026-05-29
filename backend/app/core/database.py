from __future__ import annotations

from collections.abc import AsyncGenerator
import os
from pathlib import Path

from sqlalchemy import inspect
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import BACKEND_DIR, settings
from app.models.base import Base


def _query_value(value: str | tuple[str, ...] | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, tuple):
        return value[0] if value else None
    return value


def _sanitize_postgres_url_for_asyncpg(url: URL) -> tuple[URL, dict[str, object]]:
    if url.get_backend_name() != "postgresql":
        return url, {}

    query = dict(url.query)
    connect_args: dict[str, object] = {
        # Keeps asyncpg stable on managed Postgres instances.
        "server_settings": {"jit": "off"}
    }

    # Managed providers sometimes append this and asyncpg can reject it.
    query.pop("target_session_attrs", None)

    ssl = _query_value(query.pop("ssl", None))
    sslmode = _query_value(query.pop("sslmode", None))
    requested_ssl = (ssl or sslmode or "").strip().lower()

    if requested_ssl:
        if requested_ssl in {"disable", "false", "0", "off"}:
            connect_args["ssl"] = False
        else:
            # Convert libpq-style SSL modes to asyncpg-compatible SSL setting.
            connect_args["ssl"] = "require"

    return url.set(query=query), connect_args


def _resolved_database_config() -> tuple[URL, dict[str, object]]:
    raw_database_url = (
        os.environ.get("DATABASE_URL")
        or settings.database_url
    ).strip()
    if raw_database_url.startswith("postgres://"):
        raw_database_url = "postgresql://" + raw_database_url[len("postgres://") :]

    url = make_url(raw_database_url)
    if url.get_backend_name() == "postgresql" and url.drivername != "postgresql+asyncpg":
        url = url.set(drivername="postgresql+asyncpg")

    if url.get_backend_name() != "sqlite" or not url.database:
        return _sanitize_postgres_url_for_asyncpg(url)

    sqlite_path = Path(url.database)
    if sqlite_path.is_absolute():
        return url, {}

    absolute_path = (BACKEND_DIR / sqlite_path).resolve()
    return url.set(database=str(absolute_path)), {}


DATABASE_URL, DATABASE_CONNECT_ARGS = _resolved_database_config()
engine = create_async_engine(
    DATABASE_URL,
    future=True,
    pool_pre_ping=True,
    connect_args=DATABASE_CONNECT_ARGS,
)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
IS_SQLITE = DATABASE_URL.get_backend_name() == "sqlite"

async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    session = AsyncSessionLocal()
    try:
        yield session
    finally:
        await session.close()


def _ensure_runtime_columns(sync_conn: object) -> None:
    inspector = inspect(sync_conn)
    dialect_name = inspector.bind.dialect.name if inspector.bind is not None else ""
    users_schema = None if dialect_name == "sqlite" else "public"
    if not inspector.has_table("users", schema=users_schema):
        return

    existing_columns = {
        column["name"] for column in inspector.get_columns("users", schema=users_schema)
    }
    bind = inspector.bind
    if bind is None:
        return

    def add_column_if_missing(column_name: str, sqlite_definition: str, postgres_definition: str) -> None:
        if column_name in existing_columns:
            return
        if dialect_name == "sqlite":
            bind.exec_driver_sql(f"ALTER TABLE users ADD COLUMN {column_name} {sqlite_definition}")
            return
        bind.exec_driver_sql(
            f"ALTER TABLE public.users ADD COLUMN IF NOT EXISTS {column_name} {postgres_definition}"
        )

    if dialect_name == "sqlite":
        add_column_if_missing("email", "VARCHAR(255)", "VARCHAR(255)")
        add_column_if_missing("password_hash", "VARCHAR(255)", "VARCHAR(255)")
        add_column_if_missing("gender", "VARCHAR(16)", "VARCHAR(16)")
        add_column_if_missing("preferred_gender", "VARCHAR(16) DEFAULT 'both'", "VARCHAR(16) DEFAULT 'both'")
        add_column_if_missing("profile_image_url", "VARCHAR(500)", "VARCHAR(500)")
        add_column_if_missing("age", "INTEGER", "INTEGER")
        add_column_if_missing("country_code", "VARCHAR(2)", "VARCHAR(2)")
        add_column_if_missing("country_name", "VARCHAR(80)", "VARCHAR(80)")
        add_column_if_missing("latitude", "FLOAT", "DOUBLE PRECISION")
        add_column_if_missing("longitude", "FLOAT", "DOUBLE PRECISION")
        add_column_if_missing("otp_verified", "BOOLEAN NOT NULL DEFAULT 0", "BOOLEAN NOT NULL DEFAULT FALSE")
        add_column_if_missing("face_verified", "BOOLEAN NOT NULL DEFAULT 0", "BOOLEAN NOT NULL DEFAULT FALSE")
        add_column_if_missing("is_premium", "BOOLEAN NOT NULL DEFAULT 0", "BOOLEAN NOT NULL DEFAULT FALSE")
        add_column_if_missing("is_bot", "BOOLEAN NOT NULL DEFAULT 0", "BOOLEAN NOT NULL DEFAULT FALSE")
        add_column_if_missing("swipe_blocked_until", "DATETIME", "TIMESTAMPTZ")
        add_column_if_missing("koordinati", "VARCHAR(64)", "VARCHAR(64)")
        return

    add_column_if_missing("email", "VARCHAR(255)", "VARCHAR(255)")
    add_column_if_missing("password_hash", "VARCHAR(255)", "VARCHAR(255)")
    add_column_if_missing("gender", "VARCHAR(16)", "VARCHAR(16)")
    add_column_if_missing("preferred_gender", "VARCHAR(16) DEFAULT 'both'", "VARCHAR(16) DEFAULT 'both'")
    add_column_if_missing("profile_image_url", "VARCHAR(500)", "VARCHAR(500)")
    add_column_if_missing("age", "INTEGER", "INTEGER")
    add_column_if_missing("country_code", "VARCHAR(2)", "VARCHAR(2)")
    add_column_if_missing("country_name", "VARCHAR(80)", "VARCHAR(80)")
    add_column_if_missing("latitude", "FLOAT", "DOUBLE PRECISION")
    add_column_if_missing("longitude", "FLOAT", "DOUBLE PRECISION")
    add_column_if_missing("otp_verified", "BOOLEAN NOT NULL DEFAULT FALSE", "BOOLEAN NOT NULL DEFAULT FALSE")
    add_column_if_missing("face_verified", "BOOLEAN NOT NULL DEFAULT FALSE", "BOOLEAN NOT NULL DEFAULT FALSE")
    add_column_if_missing("is_premium", "BOOLEAN NOT NULL DEFAULT FALSE", "BOOLEAN NOT NULL DEFAULT FALSE")
    add_column_if_missing("is_bot", "BOOLEAN NOT NULL DEFAULT FALSE", "BOOLEAN NOT NULL DEFAULT FALSE")
    add_column_if_missing("swipe_blocked_until", "TIMESTAMPTZ", "TIMESTAMPTZ")
    add_column_if_missing("koordinati", "VARCHAR(64)", "VARCHAR(64)")


def _ensure_countries_table(sync_conn: object) -> None:
    inspector = inspect(sync_conn)
    bind = inspector.bind
    if bind is None:
        return

    dialect_name = bind.dialect.name
    if dialect_name == "sqlite":
        bind.exec_driver_sql(
            """
            CREATE TABLE IF NOT EXISTS countries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                country_code VARCHAR(2) NOT NULL UNIQUE,
                country_name VARCHAR(120) NOT NULL
            )
            """
        )
        existing_columns = {column["name"] for column in inspect(sync_conn).get_columns("countries")}
        if "country_code" not in existing_columns:
            bind.exec_driver_sql("ALTER TABLE countries ADD COLUMN country_code VARCHAR(2)")
        if "country_name" not in existing_columns:
            bind.exec_driver_sql("ALTER TABLE countries ADD COLUMN country_name VARCHAR(120)")
        bind.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_countries_country_code ON countries(country_code)"
        )
        return

    bind.exec_driver_sql(
        """
        CREATE TABLE IF NOT EXISTS public.countries (
            id BIGSERIAL PRIMARY KEY,
            country_code VARCHAR(2) NOT NULL,
            country_name VARCHAR(120) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_countries_country_code UNIQUE (country_code)
        )
        """
    )
    bind.exec_driver_sql(
        "ALTER TABLE public.countries ADD COLUMN IF NOT EXISTS country_code VARCHAR(2)"
    )
    bind.exec_driver_sql(
        "ALTER TABLE public.countries ADD COLUMN IF NOT EXISTS country_name VARCHAR(120)"
    )
    bind.exec_driver_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_countries_country_code ON public.countries(country_code)"
    )


async def init_db() -> None:
    # Import models lazily to avoid accidental circular imports during module load,
    # while still guaranteeing metadata is populated before create_all().
    from app.models.country import Country
    from app.models.user import User
    from app.models.vote import Vote

    _ = (Country, User, Vote)
    async with engine.begin() as conn:
        # Keep data between restarts so live activity can build up over time.
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_ensure_countries_table)
        await conn.run_sync(_ensure_runtime_columns)
