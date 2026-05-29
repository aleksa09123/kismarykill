from __future__ import annotations

from functools import cached_property
import os
from pathlib import Path

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    app_name: str = "Kiss Marry Kill API"
    supabase_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SUPABASE_URL"),
    )
    supabase_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "SUPABASE_KEY",
            "SUPABASE_ANON_KEY",
            "SUPABASE_PUBLISHABLE_KEY",
        ),
    )
    database_url: str = Field(
        default="postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/kismarykill",
        validation_alias=AliasChoices("DATABASE_URL", "database_url"),
    )
    zone_radius_km: int = 20
    round_size: int = 3
    resend_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("RESEND_API_KEY"),
    )
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    cors_allow_origin_regex: str = r"https?://(127\.0\.0\.1|localhost)(:\d+)?"
    jwt_secret_key: str = Field(
        default="change-this-in-production",
        validation_alias=AliasChoices("JWT_SECRET_KEY", "SECRET_KEY"),
    )
    jwt_algorithm: str = Field(
        default="HS256",
        validation_alias=AliasChoices("JWT_ALGORITHM", "ALGORITHM"),
    )
    jwt_access_token_expire_minutes: int = Field(
        default=60 * 24 * 7,
        validation_alias=AliasChoices(
            "JWT_ACCESS_TOKEN_EXPIRE_MINUTES",
            "ACCESS_TOKEN_EXPIRE_MINUTES",
        ),
    )
    redis_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("REDIS_URL"),
    )
    gemini_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    )
    gemini_model: str = Field(
        default="gemini-2.5-flash",
        validation_alias=AliasChoices("GEMINI_MODEL"),
    )
    environment: str = Field(
        default="development",
        validation_alias=AliasChoices("APP_ENV", "ENVIRONMENT", "NODE_ENV"),
    )

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @cached_property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @model_validator(mode="after")
    def validate_jwt_secret(self) -> "Settings":
        production_like = (
            self.environment.strip().lower() in {"production", "prod"}
            or os.environ.get("RENDER") == "true"
            or bool(os.environ.get("RENDER_SERVICE_ID"))
        )
        if production_like and self.jwt_secret_key == "change-this-in-production":
            raise ValueError(
                "JWT_SECRET_KEY or SECRET_KEY must be configured in production to keep sessions stable across restarts."
            )
        return self


settings = Settings()
