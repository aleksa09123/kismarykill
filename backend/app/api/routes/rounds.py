from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.database import get_async_session
from app.models.user import User
from app.schemas.round import GetRoundRequest, GetRoundResponse, ZoneDebugResponse
from app.services.matchmaking import MatchmakingService

router = APIRouter(tags=["rounds"])


def _resolve_coordinates(
    *,
    latitude: float | None,
    longitude: float | None,
    x_latitude: float | None,
    x_longitude: float | None,
    current_user: User,
) -> tuple[float, float]:
    resolved_latitude = latitude if latitude is not None else x_latitude
    resolved_longitude = longitude if longitude is not None else x_longitude

    if resolved_latitude is not None and resolved_longitude is not None:
        return resolved_latitude, resolved_longitude

    if current_user.latitude is not None and current_user.longitude is not None:
        return float(current_user.latitude), float(current_user.longitude)

    raise HTTPException(
        status_code=400,
        detail="latitude and longitude are required as query params or x-latitude/x-longitude headers",
    )


@router.post("/get-round", response_model=GetRoundResponse)
@router.post("/discovery", response_model=GetRoundResponse)
async def get_round(
    payload: GetRoundRequest,
    session: AsyncSession = Depends(get_async_session),
    current_user: User = Depends(get_current_user),
) -> GetRoundResponse:
    service = MatchmakingService(session)
    result = await service.get_round_candidates(
        user=current_user,
        latitude=payload.location.latitude,
        longitude=payload.location.longitude,
    )
    return GetRoundResponse(zone_id=result.zone_id, users=result.users)


@router.get("/profiles", response_model=GetRoundResponse)
async def get_profiles(
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    x_latitude: float | None = Header(default=None, alias="x-latitude"),
    x_longitude: float | None = Header(default=None, alias="x-longitude"),
    session: AsyncSession = Depends(get_async_session),
    current_user: User = Depends(get_current_user),
) -> GetRoundResponse:
    resolved_latitude, resolved_longitude = _resolve_coordinates(
        latitude=latitude,
        longitude=longitude,
        x_latitude=x_latitude,
        x_longitude=x_longitude,
        current_user=current_user,
    )

    service = MatchmakingService(session)
    result = await service.get_round_candidates(
        user=current_user,
        latitude=resolved_latitude,
        longitude=resolved_longitude,
    )
    return GetRoundResponse(zone_id=result.zone_id, users=result.users)


@router.get("/debug/zone", response_model=ZoneDebugResponse)
async def get_zone_debug(
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    x_latitude: float | None = Header(default=None, alias="x-latitude"),
    x_longitude: float | None = Header(default=None, alias="x-longitude"),
    session: AsyncSession = Depends(get_async_session),
    current_user: User = Depends(get_current_user),
) -> ZoneDebugResponse:
    resolved_latitude, resolved_longitude = _resolve_coordinates(
        latitude=latitude,
        longitude=longitude,
        x_latitude=x_latitude,
        x_longitude=x_longitude,
        current_user=current_user,
    )

    service = MatchmakingService(session)
    return await service.get_zone_debug_info(
        user=current_user,
        latitude=resolved_latitude,
        longitude=resolved_longitude,
    )
