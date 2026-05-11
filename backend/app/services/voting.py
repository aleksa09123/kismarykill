from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.vote_repository import VoteRepository
from app.schemas.vote import VoteRoundRequest

MAX_SWIPES_PER_MINUTE = 60
SWIPE_BLOCK_HOURS = 1


class VotingService:
    def __init__(self, session: AsyncSession):
        self.repository = VoteRepository(session)
        self.session = session

    async def submit_round_votes(self, voter_id: int, payload: VoteRoundRequest) -> int:
        voter = await self.repository.get_user(voter_id)
        if voter is None:
            raise HTTPException(status_code=404, detail="Voter not found")

        now = datetime.now(UTC)
        if voter.swipe_blocked_until and voter.swipe_blocked_until > now:
            raise HTTPException(
                status_code=429,
                detail=(
                    "Swipe limit exceeded. You are blocked until "
                    f"{voter.swipe_blocked_until.isoformat()}."
                ),
            )

        swipes_last_minute = await self.repository.count_swipes_since(
            voter_id=voter_id,
            since=now - timedelta(minutes=1),
        )
        projected_swipes = swipes_last_minute + len(payload.votes)
        if projected_swipes > MAX_SWIPES_PER_MINUTE:
            blocked_until = now + timedelta(hours=SWIPE_BLOCK_HOURS)
            await self.repository.set_swipe_block(voter, blocked_until)
            raise HTTPException(
                status_code=429,
                detail=(
                    "Too many swipes in a short time. "
                    f"You are blocked until {blocked_until.isoformat()}."
                ),
            )

        target_ids = {vote.target_id for vote in payload.votes}
        if voter_id in target_ids:
            raise HTTPException(status_code=400, detail="Voting for yourself is not allowed")

        existing_targets = await self.repository.get_existing_user_ids(target_ids)
        if existing_targets != target_ids:
            missing_ids = sorted(target_ids - existing_targets)
            raise HTTPException(
                status_code=400,
                detail=f"Invalid target user ids: {missing_ids}",
            )

        try:
            return await self.repository.create_votes(voter_id, payload.votes)
        except SQLAlchemyError as exc:
            await self.session.rollback()
            raise HTTPException(status_code=500, detail="Could not save votes") from exc
