from __future__ import annotations

from pydantic import BaseModel


class LeaderboardEntry(BaseModel):
    rank: int
    user_id: int
    name: str
    profile_image_url: str | None = None
    score: int
    kisses: int
    marries: int
    kills: int


class LeaderboardResponse(BaseModel):
    users: list[LeaderboardEntry]
