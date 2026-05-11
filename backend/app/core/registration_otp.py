from __future__ import annotations

import logging
import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock

from app.core.config import settings


OTP_EXPIRATION_MINUTES = 10
OTP_EMAIL_FROM = "onboarding@resend.dev"
logger = logging.getLogger(__name__)


@dataclass
class PendingRegistration:
    email: str
    name: str
    gender: str
    preferred_gender: str
    profile_image_url: str | None
    password_hash: str
    verification_code: str
    expires_at: datetime


_pending_registrations: dict[str, PendingRegistration] = {}
_lock = Lock()


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _cleanup_locked(now: datetime) -> None:
    expired_keys = [
        email for email, pending in _pending_registrations.items() if pending.expires_at <= now
    ]
    for email in expired_keys:
        _pending_registrations.pop(email, None)


def create_pending_registration(
    *,
    email: str,
    name: str,
    gender: str,
    preferred_gender: str,
    profile_image_url: str | None,
    password_hash: str,
) -> PendingRegistration:
    normalized_email = _normalize_email(email)
    now = datetime.now(UTC)
    expires_at = now + timedelta(minutes=OTP_EXPIRATION_MINUTES)
    verification_code = f"{random.randint(0, 999999):06d}"
    pending = PendingRegistration(
        email=normalized_email,
        name=name,
        gender=gender,
        preferred_gender=preferred_gender,
        profile_image_url=profile_image_url,
        password_hash=password_hash,
        verification_code=verification_code,
        expires_at=expires_at,
    )

    with _lock:
        _cleanup_locked(now)
        _pending_registrations[normalized_email] = pending

    return pending


def get_pending_registration(email: str) -> PendingRegistration | None:
    normalized_email = _normalize_email(email)
    now = datetime.now(UTC)

    with _lock:
        _cleanup_locked(now)
        return _pending_registrations.get(normalized_email)


def verify_code(email: str, code: str) -> bool:
    pending = get_pending_registration(email)
    if pending is None:
        return False

    normalized_code = code.strip()
    return normalized_code == pending.verification_code


def consume_pending_registration(email: str) -> PendingRegistration | None:
    normalized_email = _normalize_email(email)
    now = datetime.now(UTC)

    with _lock:
        _cleanup_locked(now)
        return _pending_registrations.pop(normalized_email, None)


def send_otp_email(email: str, otp: str) -> bool:
    try:
        import resend
    except Exception:
        logger.exception("Resend package is unavailable; OTP email delivery skipped for %s", email)
        return False

    if not settings.resend_api_key:
        logger.error("RESEND_API_KEY is not configured; OTP email delivery skipped for %s", email)
        return False

    try:
        resend.api_key = settings.resend_api_key
        resend.Emails.send(
            {
                "from": f"Kiss Marry Kill <{OTP_EMAIL_FROM}>",
                "to": [email],
                "subject": "Your Verification Code - Kiss Marry Kill",
                "html": (
                    "<div style='font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;'>"
                    "<h2 style='margin:0 0 12px;'>Kiss Marry Kill Verification</h2>"
                    "<p style='margin:0 0 14px;'>Hello!</p>"
                    "<p style='margin:0 0 10px;'>Your 6-digit verification code is:</p>"
                    f"<p style='margin:0 0 14px;font-size:30px;font-weight:700;letter-spacing:4px;'>{otp}</p>"
                    "<p style='margin:0 0 8px;'>It expires in 10 minutes.</p>"
                    "<p style='margin:0;'>If you did not request this code, you can safely ignore this email.</p>"
                    "</div>"
                ),
            }
        )
        return True
    except Exception:
        logger.exception("Failed to send OTP email via Resend to %s", email)
        return False
