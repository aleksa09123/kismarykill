from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
import jwt
from jwt import InvalidTokenError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.config import settings
from app.core.database import get_async_session
from app.core.location_context import decode_location_cookie_value
from app.models.user import User
from app.schemas.blind_mode import (
    BlindModeResponse,
    BlindModeRevealedProfile,
    BlindModeSubmitRequest,
    BlindModeSubmitResponse,
)
from app.services.blind_mode import GeminiBlindModeService
from app.services.bot_simulation import BOT_TARGET_COUNT, ENABLE_API_BOTS, BotSimulationService
from app.services.matchmaking import MatchmakingService
from app.services.voting import VotingService

router = APIRouter(tags=["blind-mode"])
BLIND_ROUND_TOKEN_HEADER = "X-Blind-Round-Token"
BLIND_ROUND_TOKEN_SCOPE = "blind_mode_round"
BLIND_ROUND_TOKEN_MINUTES = 15


def _create_blind_round_token(*, voter_id: int, target_id: int) -> str:
    now = datetime.now(UTC)
    payload = {
        "scope": BLIND_ROUND_TOKEN_SCOPE,
        "voter_id": voter_id,
        "target_id": target_id,
        "iat": now,
        "exp": now + timedelta(minutes=BLIND_ROUND_TOKEN_MINUTES),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def _decode_blind_round_token(*, token: str, voter_id: int) -> int:
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid blind round token") from exc

    if payload.get("scope") != BLIND_ROUND_TOKEN_SCOPE:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid blind round token")
    if int(payload.get("voter_id") or 0) != voter_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Blind round token does not match user")

    target_id = int(payload.get("target_id") or 0)
    if target_id <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid blind target")
    return target_id


async def _prepare_blind_candidate(
    *,
    request: Request,
    session: AsyncSession,
    current_user: User,
) -> User:
    location_context = decode_location_cookie_value(request.cookies.get("user_location"))
    use_api_bots = location_context.is_global and ENABLE_API_BOTS

    if use_api_bots:
        bot_service = BotSimulationService(session)
        await bot_service.ensure_bots_seeded_for_location(
            country_code=location_context.country_code,
            country_name=location_context.country_name,
            latitude=location_context.latitude,
            longitude=location_context.longitude,
            target_count=BOT_TARGET_COUNT,
        )
        await bot_service.simulate_paced_activity_for_user(
            current_user,
            country_code=location_context.country_code,
        )

    service = MatchmakingService(session)
    result = await service.get_round_candidates(
        user=current_user,
        country_code=location_context.country_code,
        country_name=location_context.country_name,
        latitude=location_context.latitude,
        longitude=location_context.longitude,
        use_bots=use_api_bots,
        round_size=1,
    )
    if not result.users:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No blind profiles are available right now")

    candidate = await session.get(User, result.users[0].target_id)
    if candidate is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Blind profile no longer exists")
    return candidate


@router.get("/blind-mode", response_model=BlindModeResponse)
async def get_blind_mode_round(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_async_session),
    current_user: User = Depends(get_current_user),
) -> BlindModeResponse:
    candidate = await _prepare_blind_candidate(
        request=request,
        session=session,
        current_user=current_user,
    )
    blind_payload = await GeminiBlindModeService().anonymize_profile(candidate)
    response.headers[BLIND_ROUND_TOKEN_HEADER] = _create_blind_round_token(
        voter_id=current_user.id,
        target_id=candidate.id,
    )
    response.headers["Access-Control-Expose-Headers"] = BLIND_ROUND_TOKEN_HEADER
    return blind_payload


@router.post("/blind-mode/submit", response_model=BlindModeSubmitResponse)
async def submit_blind_mode_choice(
    payload: BlindModeSubmitRequest,
    session: AsyncSession = Depends(get_async_session),
    current_user: User = Depends(get_current_user),
) -> BlindModeSubmitResponse:
    target_id = _decode_blind_round_token(
        token=payload.round_token,
        voter_id=current_user.id,
    )
    target = await session.get(User, target_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Blind profile no longer exists")

    saved_votes = await VotingService(session).submit_blind_vote(
        voter_id=current_user.id,
        target_id=target_id,
        action=payload.action,
    )
    return BlindModeSubmitResponse(
        status="ok",
        saved_votes=saved_votes,
        action=payload.action,
        revealed_profile=BlindModeRevealedProfile(
            target_id=target.id,
            name=target.ime,
            profile_image_url=target.profile_image_url or target.slika_url,
            gender=target.gender or (target.pol.value if target.pol else "male"),
            age=target.age,
        ),
    )
