from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Enum as SAEnum, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.enums import VoteType


class Vote(Base):
    __tablename__ = "votes"
    __table_args__ = (CheckConstraint("voter_id <> target_id", name="ck_vote_self_target"),)

    voter_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    target_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tip_glasa: Mapped[VoteType] = mapped_column(
        SAEnum(VoteType, name="vote_type_enum"),
        nullable=False,
    )
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        primary_key=True,
        server_default=func.now(),
    )

    voter: Mapped["User"] = relationship("User", foreign_keys=[voter_id], back_populates="votes_cast")
    target: Mapped["User"] = relationship(
        "User",
        foreign_keys=[target_id],
        back_populates="votes_received",
    )
