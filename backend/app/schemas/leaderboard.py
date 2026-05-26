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
    rounds_played: int = 0
    win_rate: float = 0.0


class LeaderboardResponse(BaseModel):
    users: list[LeaderboardEntry]
    current_user_rank: LeaderboardEntry | None = None
    country_code: str | None = None
    country_name: str | None = None
    mode: str | None = None
