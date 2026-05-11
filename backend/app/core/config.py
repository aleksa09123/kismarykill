from __future__ import annotations

from functools import cached_property
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    app_name: str = "Kiss Marry Kill API"
    database_url: str = "postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/kismarykill"
    zone_radius_km: int = 20
    round_size: int = 3
    resend_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("RESEND_API_KEY"),
    )
    cors_origins: str = (
        "http://192.168.100.91:3000,"
        "http://192.168.100.91"
    )
    cors_allow_origin_regex: str = r"https?://(127\.0\.0\.1|192\.168\.100\.91)(:\d+)?"
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

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @cached_property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
