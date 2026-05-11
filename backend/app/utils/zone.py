from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from uuid import uuid4

from app.utils.geo import haversine_distance_km


@dataclass(frozen=True)
class GeoZone:
    id: str
    center_latitude: float
    center_longitude: float


_zones: list[GeoZone] = []
_lock = Lock()


def resolve_or_create_zone(latitude: float, longitude: float, radius_km: float) -> GeoZone:
    with _lock:
        for zone in _zones:
            if (
                haversine_distance_km(
                    latitude,
                    longitude,
                    zone.center_latitude,
                    zone.center_longitude,
                )
                <= radius_km
            ):
                return zone

        new_zone = GeoZone(
            id=f"zone_{len(_zones) + 1}_{uuid4().hex[:8]}",
            center_latitude=latitude,
            center_longitude=longitude,
        )
        _zones.append(new_zone)
        return new_zone
