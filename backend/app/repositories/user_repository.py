from __future__ import annotations

import random
from types import SimpleNamespace

from geoalchemy2 import WKTElement
from sqlalchemy import String, cast, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.engine.row import Row
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.user import User
from app.utils.geo import haversine_distance_km

IS_SQLITE = make_url(settings.database_url).get_backend_name() == "sqlite"


def _point_wkt(latitude: float, longitude: float) -> str:
    return f"POINT({longitude} {latitude})"


def _parse_point_wkt(value: object) -> tuple[float, float] | None:
    if value is None:
        return None

    text = value.decode() if isinstance(value, (bytes, bytearray)) else str(value)
    normalized = text.strip()
    if not normalized.upper().startswith("POINT(") or not normalized.endswith(")"):
        return None

    payload = normalized[6:-1].strip()
    parts = payload.split()
    if len(parts) != 2:
        return None

    longitude, latitude = float(parts[0]), float(parts[1])
    return latitude, longitude


class UserRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_by_id(self, user_id: int) -> User | None:
        return await self.session.get(User, user_id)

    async def update_location(self, user: User, latitude: float, longitude: float) -> None:
        user.latitude = latitude
        user.longitude = longitude
        if IS_SQLITE:
            user.koordinati = _point_wkt(latitude=latitude, longitude=longitude)
        else:
            user.koordinati = WKTElement(_point_wkt(latitude=latitude, longitude=longitude), srid=4326)
        await self.session.commit()

    async def get_random_users_in_radius(
        self,
        current_user_id: int,
        required_gender: str,
        latitude: float,
        longitude: float,
        radius_km: float,
        limit: int,
    ) -> list[Row | SimpleNamespace]:
        user_gender = func.coalesce(User.gender, cast(User.pol, String))

        geo_latitude = None
        geo_longitude = None
        if not IS_SQLITE:
            geo_latitude = func.ST_Y(User.koordinati).label("geo_latitude")
            geo_longitude = func.ST_X(User.koordinati).label("geo_longitude")

        selected_columns = [
            User.id,
            User.ime.label("name"),
            func.coalesce(User.profile_image_url, User.slika_url).label("profile_image_url"),
            user_gender.label("gender"),
            User.latitude.label("latitude"),
            User.longitude.label("longitude"),
            User.koordinati.label("koordinati"),
        ]
        if geo_latitude is not None and geo_longitude is not None:
            selected_columns.extend([geo_latitude, geo_longitude])

        stmt = (
            select(*selected_columns)
            .where(User.id != current_user_id)
            .where(
                User.latitude.is_not(None)
                | User.longitude.is_not(None)
                | User.koordinati.is_not(None)
            )
        )

        if required_gender in {"male", "female"}:
            stmt = stmt.where(user_gender == required_gender)

        rows = (await self.session.execute(stmt)).all()
        candidates: list[SimpleNamespace] = []
        for row in rows:
            candidate_latitude = float(row.latitude) if row.latitude is not None else None
            candidate_longitude = float(row.longitude) if row.longitude is not None else None

            if candidate_latitude is None or candidate_longitude is None:
                if not IS_SQLITE and hasattr(row, "geo_latitude") and hasattr(row, "geo_longitude"):
                    geo_latitude_value = getattr(row, "geo_latitude")
                    geo_longitude_value = getattr(row, "geo_longitude")
                    if geo_latitude_value is not None and geo_longitude_value is not None:
                        candidate_latitude = float(geo_latitude_value)
                        candidate_longitude = float(geo_longitude_value)

            if candidate_latitude is None or candidate_longitude is None:
                parsed = _parse_point_wkt(row.koordinati)
                if parsed is not None:
                    candidate_latitude, candidate_longitude = parsed

            if candidate_latitude is None or candidate_longitude is None:
                continue

            distance_km = haversine_distance_km(
                latitude,
                longitude,
                candidate_latitude,
                candidate_longitude,
            )
            if distance_km > radius_km:
                continue

            candidates.append(
                SimpleNamespace(
                    id=row.id,
                    name=row.name,
                    profile_image_url=row.profile_image_url,
                    gender=row.gender,
                    latitude=candidate_latitude,
                    longitude=candidate_longitude,
                    distance_m=distance_km * 1000,
                )
            )

        random.shuffle(candidates)
        return candidates[:limit]

    async def get_profiles_within_radius(
        self,
        *,
        current_user_id: int,
        latitude: float,
        longitude: float,
        radius_km: float,
    ) -> list[SimpleNamespace]:
        user_gender = func.coalesce(User.gender, cast(User.pol, String))
        geo_latitude = None
        geo_longitude = None
        if not IS_SQLITE:
            geo_latitude = func.ST_Y(User.koordinati).label("geo_latitude")
            geo_longitude = func.ST_X(User.koordinati).label("geo_longitude")

        selected_columns = [
            User.id,
            User.ime.label("name"),
            user_gender.label("gender"),
            User.latitude.label("latitude"),
            User.longitude.label("longitude"),
            User.koordinati.label("koordinati"),
        ]
        if geo_latitude is not None and geo_longitude is not None:
            selected_columns.extend([geo_latitude, geo_longitude])

        rows = (
            await self.session.execute(
                select(*selected_columns)
                .where(User.id != current_user_id)
                .where(
                    User.latitude.is_not(None)
                    | User.longitude.is_not(None)
                    | User.koordinati.is_not(None)
                )
            )
        ).all()

        nearby_profiles: list[SimpleNamespace] = []
        for row in rows:
            candidate_latitude = float(row.latitude) if row.latitude is not None else None
            candidate_longitude = float(row.longitude) if row.longitude is not None else None

            if candidate_latitude is None or candidate_longitude is None:
                if not IS_SQLITE and hasattr(row, "geo_latitude") and hasattr(row, "geo_longitude"):
                    geo_latitude_value = getattr(row, "geo_latitude")
                    geo_longitude_value = getattr(row, "geo_longitude")
                    if geo_latitude_value is not None and geo_longitude_value is not None:
                        candidate_latitude = float(geo_latitude_value)
                        candidate_longitude = float(geo_longitude_value)

            if candidate_latitude is None or candidate_longitude is None:
                parsed = _parse_point_wkt(row.koordinati)
                if parsed is not None:
                    candidate_latitude, candidate_longitude = parsed

            if candidate_latitude is None or candidate_longitude is None:
                continue

            distance_km = haversine_distance_km(
                latitude,
                longitude,
                candidate_latitude,
                candidate_longitude,
            )
            if distance_km > radius_km:
                continue

            nearby_profiles.append(
                SimpleNamespace(
                    id=row.id,
                    name=row.name,
                    gender=row.gender,
                    latitude=candidate_latitude,
                    longitude=candidate_longitude,
                    distance_km=distance_km,
                )
            )

        nearby_profiles.sort(key=lambda item: item.distance_km)
        return nearby_profiles
