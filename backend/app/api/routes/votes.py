from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.database import get_async_session
from app.models.user import User
from app.schemas.vote import VoteRoundRequest, VoteRoundResponse
from app.services.voting import VotingService

router = APIRouter(tags=["votes"])


@router.post("/vote", response_model=VoteRoundResponse)
async def submit_vote(
    payload: VoteRoundRequest,
    session: AsyncSession = Depends(get_async_session),
    current_user: User = Depends(get_current_user),
) -> VoteRoundResponse:
    service = VotingService(session)
    saved_votes = await service.submit_round_votes(voter_id=current_user.id, payload=payload)
    return VoteRoundResponse(status="ok", saved_votes=saved_votes)
