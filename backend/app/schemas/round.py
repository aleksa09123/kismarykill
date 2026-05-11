from __future__ import annotations

from pydantic import BaseModel, Field


class RoundLocation(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class GetRoundRequest(BaseModel):
    location: RoundLocation


class RoundCandidate(BaseModel):
    id: int
    name: str
    profile_image_url: str | None = None
    gender: str
    latitude: float
    longitude: float
    distance_km: float


class GetRoundResponse(BaseModel):
    zone_id: str
    users: list[RoundCandidate]


class ZoneDebugNearestProfile(BaseModel):
    user_id: int
    name: str
    distance_km: float


class ZoneDebugResponse(BaseModel):
    zone_id: str
    total_profiles_within_radius: int
    nearest_profiles: list[ZoneDebugNearestProfile]
