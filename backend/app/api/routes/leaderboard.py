from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import Integer, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.database import get_async_session
from app.models.enums import VoteType
from app.models.user import User
from app.models.vote import Vote
from app.schemas.leaderboard import LeaderboardEntry, LeaderboardResponse

router = APIRouter(tags=["leaderboard"])


@router.get("/leaderboard", response_model=LeaderboardResponse)
async def get_leaderboard(
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> LeaderboardResponse:
    marry_points = cast(3, Integer)
    kiss_points = cast(2, Integer)
    kill_points = cast(-1, Integer)
    zero = cast(0, Integer)
    one = cast(1, Integer)

    score_expr = func.sum(
        case(
            (Vote.tip_glasa == VoteType.marry, marry_points),
            (Vote.tip_glasa == VoteType.kiss, kiss_points),
            (Vote.tip_glasa == VoteType.kill, kill_points),
            else_=zero,
        )
    )
    kisses_expr = func.sum(case((Vote.tip_glasa == VoteType.kiss, one), else_=zero))
    marries_expr = func.sum(case((Vote.tip_glasa == VoteType.marry, one), else_=zero))
    kills_expr = func.sum(case((Vote.tip_glasa == VoteType.kill, one), else_=zero))

    stmt = (
        select(
            User.id.label("user_id"),
            User.ime.label("name"),
            func.coalesce(User.profile_image_url, User.slika_url).label("profile_image_url"),
            func.coalesce(score_expr, zero).label("score"),
            func.coalesce(kisses_expr, zero).label("kisses"),
            func.coalesce(marries_expr, zero).label("marries"),
            func.coalesce(kills_expr, zero).label("kills"),
        )
        .outerjoin(Vote, Vote.target_id == User.id)
        .group_by(User.id, User.ime, User.profile_image_url, User.slika_url)
        .order_by(
            func.coalesce(score_expr, zero).desc(),
            func.coalesce(marries_expr, zero).desc(),
            func.coalesce(kisses_expr, zero).desc(),
            User.id.asc(),
        )
        .limit(100)
    )

    rows = (await session.execute(stmt)).all()
    entries = [
        LeaderboardEntry(
            rank=index + 1,
            user_id=row.user_id,
            name=row.name,
            profile_image_url=row.profile_image_url,
            score=int(row.score),
            kisses=int(row.kisses),
            marries=int(row.marries),
            kills=int(row.kills),
        )
        for index, row in enumerate(rows)
    ]
    return LeaderboardResponse(users=entries)
