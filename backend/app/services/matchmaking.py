from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.enums import Gender
from app.models.user import User
from app.repositories.user_repository import UserRepository
from app.schemas.round import RoundCandidate, ZoneDebugNearestProfile, ZoneDebugResponse
from app.utils.zone import resolve_or_create_zone


@dataclass(frozen=True)
class MatchmakingResult:
    zone_id: str
    users: list[RoundCandidate]


def _normalized_gender(user: User) -> str:
    if user.gender in {"male", "female"}:
        return user.gender
    if user.pol == Gender.male:
        return "male"
    if user.pol == Gender.female:
        return "female"
    raise HTTPException(status_code=400, detail="Profile gender must be male or female to enter discovery")


def _required_match_gender(user: User) -> str:
    normalized_gender = _normalized_gender(user)
    if normalized_gender == "female":
        return "male"
    if normalized_gender == "male":
        return "female"
    raise HTTPException(status_code=400, detail="Profile gender must be male or female to enter discovery")


def _ensure_zone_eligibility(user: User) -> None:
    if not user.otp_verified:
        raise HTTPException(status_code=403, detail="OTP verification is required before entering Geo-Rooms")
    if not user.face_verified:
        raise HTTPException(status_code=403, detail="Face verification is required before entering Geo-Rooms")


class MatchmakingService:
    def __init__(self, session: AsyncSession):
        self.repository = UserRepository(session)

    async def get_round_candidates(
        self,
        user: User,
        latitude: float,
        longitude: float,
    ) -> MatchmakingResult:
        _ensure_zone_eligibility(user)
        await self.repository.update_location(user, latitude, longitude)

        zone = resolve_or_create_zone(
            latitude=latitude,
            longitude=longitude,
            radius_km=float(settings.zone_radius_km),
        )
        required_gender = _required_match_gender(user)

        rows = await self.repository.get_random_users_in_radius(
            current_user_id=user.id,
            required_gender=required_gender,
            latitude=latitude,
            longitude=longitude,
            radius_km=float(settings.zone_radius_km),
            limit=settings.round_size,
        )
        candidates = [
            RoundCandidate(
                id=row.id,
                name=row.name,
                profile_image_url=row.profile_image_url,
                gender=str(row.gender or "male"),
                latitude=float(row.latitude),
                longitude=float(row.longitude),
                distance_km=round(float(row.distance_m) / 1000, 2),
            )
            for row in rows
        ]
        return MatchmakingResult(zone_id=zone.id, users=candidates)

    async def get_zone_debug_info(
        self,
        *,
        user: User,
        latitude: float,
        longitude: float,
    ) -> ZoneDebugResponse:
        _ensure_zone_eligibility(user)
        await self.repository.update_location(user, latitude, longitude)

        zone = resolve_or_create_zone(
            latitude=latitude,
            longitude=longitude,
            radius_km=float(settings.zone_radius_km),
        )

        nearby_profiles = await self.repository.get_profiles_within_radius(
            current_user_id=user.id,
            latitude=latitude,
            longitude=longitude,
            radius_km=float(settings.zone_radius_km),
        )

        nearest_profiles = [
            ZoneDebugNearestProfile(
                user_id=profile.id,
                name=profile.name,
                distance_km=round(float(profile.distance_km), 2),
            )
            for profile in nearby_profiles[:3]
        ]

        return ZoneDebugResponse(
            zone_id=zone.id,
            total_profiles_within_radius=len(nearby_profiles),
            nearest_profiles=nearest_profiles,
        )
