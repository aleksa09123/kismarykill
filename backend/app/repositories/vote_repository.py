from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.vote import Vote
from app.schemas.vote import VoteInput


class VoteRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def user_exists(self, user_id: int) -> bool:
        stmt = select(User.id).where(User.id == user_id)
        return (await self.session.scalar(stmt)) is not None

    async def get_user(self, user_id: int) -> User | None:
        return await self.session.get(User, user_id)

    async def get_existing_user_ids(self, user_ids: set[int]) -> set[int]:
        if not user_ids:
            return set()

        stmt = select(User.id).where(User.id.in_(user_ids))
        rows = (await self.session.execute(stmt)).scalars().all()
        return set(rows)

    async def create_votes(self, voter_id: int, votes: list[VoteInput]) -> int:
        self.session.add_all(
            [
                Vote(voter_id=voter_id, target_id=vote.target_id, tip_glasa=vote.tip_glasa)
                for vote in votes
            ]
        )
        await self.session.commit()
        return len(votes)

    async def count_swipes_since(self, voter_id: int, since: datetime) -> int:
        stmt = (
            select(func.count())
            .select_from(Vote)
            .where(Vote.voter_id == voter_id)
            .where(Vote.timestamp >= since)
        )
        return int((await self.session.scalar(stmt)) or 0)

    async def set_swipe_block(self, user: User, blocked_until: datetime) -> None:
        user.swipe_blocked_until = blocked_until
        await self.session.commit()
