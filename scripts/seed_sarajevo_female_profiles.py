from __future__ import annotations

import asyncio
import math
import os
import random
import sys
from uuid import NAMESPACE_DNS, uuid5

from geoalchemy2 import WKTElement
from sqlalchemy import delete, or_, select
from sqlalchemy.engine import make_url

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "backend")
if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

from app.core.auth import hash_password  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.database import AsyncSessionLocal, init_db  # noqa: E402
from app.models.enums import Gender  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.vote import Vote  # noqa: E402

IS_SQLITE = make_url(settings.database_url).get_backend_name() == "sqlite"

SARAJEVO_LAT = 43.8563
SARAJEVO_LON = 18.4131
SEED_PREFIX = "GeoSeed-Sarajevo-F-"
SEED_COUNT = 5
SEED_RADIUS_KM = 5.0
EARTH_RADIUS_KM = 6371.0


def _avatar_url(seed_key: str) -> str:
    return f"https://i.pravatar.cc/300?u={uuid5(NAMESPACE_DNS, seed_key)}"


def _seed_coordinate(latitude: float, longitude: float) -> str | WKTElement:
    point = f"POINT({longitude} {latitude})"
    if IS_SQLITE:
        return point
    return WKTElement(point, srid=4326)


def _random_point_within_radius_km(center_lat: float, center_lon: float, radius_km: float) -> tuple[float, float]:
    distance = radius_km * math.sqrt(random.random())
    bearing = random.uniform(0.0, 2.0 * math.pi)

    lat1 = math.radians(center_lat)
    lon1 = math.radians(center_lon)
    angular_distance = distance / EARTH_RADIUS_KM

    lat2 = math.asin(
        math.sin(lat1) * math.cos(angular_distance)
        + math.cos(lat1) * math.sin(angular_distance) * math.cos(bearing)
    )
    lon2 = lon1 + math.atan2(
        math.sin(bearing) * math.sin(angular_distance) * math.cos(lat1),
        math.cos(angular_distance) - math.sin(lat1) * math.sin(lat2),
    )

    return math.degrees(lat2), math.degrees(lon2)


async def seed_sarajevo_profiles() -> None:
    random.seed(20260510)
    await init_db()

    async with AsyncSessionLocal() as session:
        seeded_user_ids = select(User.id).where(User.ime.like(f"{SEED_PREFIX}%"))
        await session.execute(
            delete(Vote).where(
                or_(
                    Vote.voter_id.in_(seeded_user_ids),
                    Vote.target_id.in_(seeded_user_ids),
                )
            )
        )
        await session.execute(delete(User).where(User.ime.like(f"{SEED_PREFIX}%")))
        await session.commit()

        password_hash = hash_password("GeoSeedPass123!")
        users: list[User] = []
        for index in range(1, SEED_COUNT + 1):
            latitude, longitude = _random_point_within_radius_km(
                center_lat=SARAJEVO_LAT,
                center_lon=SARAJEVO_LON,
                radius_km=SEED_RADIUS_KM,
            )
            email = f"geo-sarajevo-f-{index:02d}@example.com"
            image_url = _avatar_url(email)

            users.append(
                User(
                    ime=f"{SEED_PREFIX}{index:02d}",
                    slika_url=image_url,
                    pol=Gender.female,
                    email=email,
                    password_hash=password_hash,
                    gender="female",
                    preferred_gender="male",
                    profile_image_url=image_url,
                    latitude=latitude,
                    longitude=longitude,
                    otp_verified=True,
                    face_verified=True,
                    koordinati=_seed_coordinate(latitude, longitude),
                )
            )

        session.add_all(users)
        await session.commit()
        print(
            f"Seeded {SEED_COUNT} female profiles within {SEED_RADIUS_KM:.1f}km "
            f"of Sarajevo ({SARAJEVO_LAT}, {SARAJEVO_LON})."
        )


if __name__ == "__main__":
    asyncio.run(seed_sarajevo_profiles())
