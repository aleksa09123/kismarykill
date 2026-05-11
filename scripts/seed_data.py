from __future__ import annotations

import asyncio
import os
import random
import sys
from dataclasses import dataclass
from uuid import uuid5, NAMESPACE_DNS

from geoalchemy2 import WKTElement
from sqlalchemy import delete, or_, select
from sqlalchemy.engine import make_url

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "backend")
if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

from app.core.database import AsyncSessionLocal, init_db  # noqa: E402
from app.core.auth import hash_password  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.models.enums import Gender  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.vote import Vote  # noqa: E402

IS_SQLITE = make_url(settings.database_url).get_backend_name() == "sqlite"


@dataclass(frozen=True)
class CitySeed:
    name: str
    latitude: float
    longitude: float


CITIES = [
    CitySeed(name="Sarajevo", latitude=43.8563, longitude=18.4131),
    CitySeed(name="Beograd", latitude=44.7866, longitude=20.4489),
    CitySeed(name="Zagreb", latitude=45.8150, longitude=15.9819),
]

MALE_NAMES = [
    "Marko",
    "Stefan",
    "Nikola",
    "Luka",
    "Milos",
    "Dusan",
    "Andrej",
    "Filip",
    "Vuk",
    "Petar",
    "Nemanja",
    "Aleksa",
    "Bojan",
    "Mihajlo",
    "Damir",
    "Tarik",
    "Emir",
    "Ivan",
    "Karlo",
    "Dino",
]

FEMALE_NAMES = [
    "Ana",
    "Mia",
    "Lea",
    "Sara",
    "Nina",
    "Ivana",
    "Maja",
    "Jelena",
    "Tamara",
    "Katarina",
    "Una",
    "Ena",
    "Lana",
    "Andrea",
    "Tea",
    "Nevena",
    "Milica",
    "Dunja",
    "Amina",
    "Iva",
]

RANDOM_OFFSET_DEGREES = 0.045
PROFILES_PER_GENDER = 20


def _randomized_coordinates(base_latitude: float, base_longitude: float) -> tuple[float, float]:
    lat_offset = random.uniform(-RANDOM_OFFSET_DEGREES, RANDOM_OFFSET_DEGREES)
    lon_offset = random.uniform(-RANDOM_OFFSET_DEGREES, RANDOM_OFFSET_DEGREES)
    return base_latitude + lat_offset, base_longitude + lon_offset


def _avatar_url(seed_key: str) -> str:
    unique_id = uuid5(NAMESPACE_DNS, seed_key)
    return f"https://i.pravatar.cc/300?u={unique_id}"


def _seed_coordinate(latitude: float, longitude: float) -> str | WKTElement:
    point = f"POINT({longitude} {latitude})"
    if IS_SQLITE:
        return point
    return WKTElement(point, srid=4326)


def _build_seed_users() -> list[User]:
    users: list[User] = []
    seed_password_hash = hash_password("SeedPass123!")

    for city in CITIES:
        male_pool = MALE_NAMES[:]
        female_pool = FEMALE_NAMES[:]
        random.shuffle(male_pool)
        random.shuffle(female_pool)

        for index in range(PROFILES_PER_GENDER):
            lat, lon = _randomized_coordinates(city.latitude, city.longitude)
            male_name = male_pool[index]
            seed_key = f"seed-{city.name.lower()}-m-{index + 1:02d}"
            profile_image_url = _avatar_url(seed_key)
            users.append(
                User(
                    ime=f"Seed-{city.name}-M-{index + 1:02d}-{male_name}",
                    slika_url=profile_image_url,
                    pol=Gender.male,
                    email=f"{seed_key}@example.com",
                    password_hash=seed_password_hash,
                    gender="male",
                    preferred_gender="female",
                    profile_image_url=profile_image_url,
                    koordinati=_seed_coordinate(lat, lon),
                )
            )

        for index in range(PROFILES_PER_GENDER):
            lat, lon = _randomized_coordinates(city.latitude, city.longitude)
            female_name = female_pool[index]
            seed_key = f"seed-{city.name.lower()}-f-{index + 1:02d}"
            profile_image_url = _avatar_url(seed_key)
            users.append(
                User(
                    ime=f"Seed-{city.name}-F-{index + 1:02d}-{female_name}",
                    slika_url=profile_image_url,
                    pol=Gender.female,
                    email=f"{seed_key}@example.com",
                    password_hash=seed_password_hash,
                    gender="female",
                    preferred_gender="male",
                    profile_image_url=profile_image_url,
                    koordinati=_seed_coordinate(lat, lon),
                )
            )

    return users


async def seed_data() -> None:
    random.seed(20260506)
    await init_db()

    async with AsyncSessionLocal() as session:
        seed_user_ids_query = select(User.id).where(User.ime.like("Seed-%"))
        await session.execute(
            delete(Vote).where(
                or_(
                    Vote.voter_id.in_(seed_user_ids_query),
                    Vote.target_id.in_(seed_user_ids_query),
                )
            )
        )
        await session.execute(delete(User).where(User.ime.like("Seed-%")))
        await session.commit()

        users = _build_seed_users()
        session.add_all(users)
        await session.commit()

        print(
            "Inserted "
            f"{len(users)} users total ({len(users) // 2} male, {len(users) // 2} female) "
            "across Sarajevo, Beograd and Zagreb."
        )


if __name__ == "__main__":
    asyncio.run(seed_data())
