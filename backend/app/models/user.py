from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Enum as SAEnum, Float, Integer, String, false, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.enums import Gender


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "gender IS NULL OR gender IN ('male', 'female')",
            name="ck_users_gender_values",
        ),
        CheckConstraint(
            "preferred_gender IS NULL OR preferred_gender IN ('male', 'female', 'both')",
            name="ck_users_preferred_gender_values",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Legacy local-language fields used by existing game flow.
    ime: Mapped[str] = mapped_column(String(120), nullable=False)
    slika_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    pol: Mapped[Gender] = mapped_column(
        SAEnum(Gender, name="gender_enum"),
        nullable=False,
        index=True,
    )

    # SaaS-friendly profile/auth fields.
    email: Mapped[str | None] = mapped_column(String(255), unique=True, index=True, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    gender: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    preferred_gender: Mapped[str | None] = mapped_column(
        String(16),
        nullable=True,
        index=True,
        server_default="both",
    )
    profile_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    otp_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    face_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    swipe_blocked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    koordinati: Mapped[str | None] = mapped_column(String(64), nullable=True)
    datum_registracije: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    votes_cast: Mapped[list["Vote"]] = relationship(
        "Vote",
        foreign_keys="Vote.voter_id",
        back_populates="voter",
    )
    votes_received: Mapped[list["Vote"]] = relationship(
        "Vote",
        foreign_keys="Vote.target_id",
        back_populates="target",
    )
