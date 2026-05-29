from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from app.models.enums import VoteType


ALLOWED_AESTHETIC_THEMES: tuple[str, ...] = (
    "bg-gradient-to-br from-fuchsia-600 via-violet-600 to-cyan-500",
    "bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300",
    "bg-gradient-to-br from-emerald-500 via-teal-500 to-sky-500",
    "bg-gradient-to-br from-indigo-600 via-blue-500 to-lime-300",
    "bg-gradient-to-br from-pink-500 via-red-500 to-yellow-400",
)


class BlindModeResponse(BaseModel):
    anonymous_hook: str = Field(min_length=1, max_length=180)
    unpopular_opinion: str = Field(min_length=1, max_length=260)
    vibe_check: str = Field(min_length=1, max_length=320)
    aesthetic_theme: str = Field(min_length=1, max_length=120)

    @field_validator("anonymous_hook", "unpopular_opinion", "vibe_check", "aesthetic_theme", mode="before")
    @classmethod
    def coerce_text(cls, value: object) -> str:
        if isinstance(value, list):
            return "\n".join(str(item).strip() for item in value if str(item).strip())
        return str(value or "").strip()


class BlindModeSubmitRequest(BaseModel):
    action: VoteType
    round_token: str = Field(min_length=16, max_length=2048)


class BlindModeRevealedProfile(BaseModel):
    target_id: int
    name: str
    profile_image_url: str | None = None
    gender: str
    age: int | None = None


class BlindModeSubmitResponse(BaseModel):
    status: str
    saved_votes: int
    action: VoteType
    revealed_profile: BlindModeRevealedProfile
