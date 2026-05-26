from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
import logging

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jwt import InvalidTokenError
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_async_session
from app.models.enums import Gender
from app.models.user import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login")
logger = logging.getLogger(__name__)


class UserNotFoundForTokenError(Exception):
    """Raised when JWT is valid but the referenced user no longer exists."""


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    return pwd_context.verify(password, password_hash)


def _normalize_boolean(value: object | None, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "t", "yes", "y"}:
            return True
        if normalized in {"0", "false", "f", "no", "n"}:
            return False
    return default


def _normalize_gender(value: object | None, fallback: str = "male") -> str:
    if value is None:
        return fallback
    normalized = str(value).strip().lower()
    if normalized.startswith("gender."):
        normalized = normalized.split(".", 1)[1]
    if normalized in {"male", "female"}:
        return normalized
    return fallback


def _normalize_preferred_gender(value: object | None, fallback: str = "both") -> str:
    if value is None:
        return fallback
    normalized = str(value).strip().lower()
    if normalized in {"male", "female", "both"}:
        return normalized
    return fallback


def _fallback_name_from_email(email: str) -> str:
    local_part = email.split("@", 1)[0].strip()
    if not local_part:
        return "Player"
    candidate = local_part.replace(".", " ").replace("_", " ").strip()
    return candidate[:120] if candidate else "Player"


def _password_hash_from_row(user_row: dict[str, object]) -> str | None:
    password_hash = user_row.get("password_hash")
    if password_hash:
        return str(password_hash)
    hashed_password = user_row.get("hashed_password")
    if hashed_password:
        return str(hashed_password)
    return None


def _extract_supabase_row(response: object) -> dict[str, object] | None:
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and data:
        first_item = data[0]
        if isinstance(first_item, dict):
            return first_item
    return None


async def _sync_local_user_from_supabase_row(
    *,
    session: AsyncSession,
    user_row: dict[str, object],
) -> User | None:
    user_id_raw = user_row.get("id")
    if user_id_raw is None:
        return None

    user_id = int(user_id_raw)
    email = str(user_row.get("email") or "").strip()
    name = str(user_row.get("ime") or user_row.get("name") or "").strip() or _fallback_name_from_email(email)
    profile_image_url = (
        str(user_row.get("profile_image_url"))
        if user_row.get("profile_image_url")
        else (str(user_row.get("slika_url")) if user_row.get("slika_url") else None)
    )
    gender = _normalize_gender(user_row.get("gender") or user_row.get("pol"), "male")
    preferred_gender = _normalize_preferred_gender(user_row.get("preferred_gender"), "both")
    otp_verified = (
        _normalize_boolean(user_row.get("otp_verified"), default=True)
        if "otp_verified" in user_row
        else True
    )
    face_verified = _normalize_boolean(user_row.get("face_verified"), default=False)
    is_premium = (
        _normalize_boolean(user_row.get("is_premium"), default=False)
        if "is_premium" in user_row
        else _normalize_boolean(user_row.get("is_vip"), default=False)
    )

    local_user = await session.get(User, user_id)
    gender_enum = Gender.female if gender == "female" else Gender.male

    if local_user is None:
        local_user = User(
            id=user_id,
            ime=name,
            slika_url=profile_image_url,
            pol=gender_enum,
            email=email or None,
            password_hash=_password_hash_from_row(user_row),
            gender=gender,
            preferred_gender=preferred_gender,
            country_code=str(user_row.get("country_code")).upper() if user_row.get("country_code") else None,
            country_name=str(user_row.get("country_name") or "").strip() or None,
            profile_image_url=profile_image_url,
            otp_verified=otp_verified,
            face_verified=face_verified,
            is_premium=is_premium,
            is_bot=_normalize_boolean(user_row.get("is_bot"), default=False),
        )
        session.add(local_user)
    else:
        # Keep existing Postgres profile data authoritative; Supabase rows are only
        # a hydration fallback and can lag behind local profile edits.
        if not local_user.ime:
            local_user.ime = name
        if not local_user.slika_url and profile_image_url:
            local_user.slika_url = profile_image_url
        if not local_user.profile_image_url and profile_image_url:
            local_user.profile_image_url = profile_image_url
        if local_user.pol is None:
            local_user.pol = gender_enum
        local_user.email = email or None
        password_hash = _password_hash_from_row(user_row)
        if password_hash:
            local_user.password_hash = password_hash
        if not local_user.gender:
            local_user.gender = gender
        if not local_user.preferred_gender:
            local_user.preferred_gender = preferred_gender
        if not local_user.country_code and user_row.get("country_code"):
            local_user.country_code = str(user_row.get("country_code")).upper()
        if not local_user.country_name and user_row.get("country_name"):
            local_user.country_name = str(user_row.get("country_name") or "").strip() or None
        local_user.otp_verified = bool(local_user.otp_verified or otp_verified)
        local_user.face_verified = bool(local_user.face_verified or face_verified)
        local_user.is_premium = bool(local_user.is_premium or is_premium)
        local_user.is_bot = bool(
            local_user.is_bot or _normalize_boolean(user_row.get("is_bot"), default=False)
        )

    await session.commit()
    await session.refresh(local_user)
    return local_user


def create_access_token(user_id: int, expires_minutes: int | None = None) -> str:
    lifetime = expires_minutes or settings.jwt_access_token_expire_minutes
    expires_at = datetime.now(UTC) + timedelta(minutes=lifetime)
    payload = {"sub": str(user_id), "exp": expires_at}
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> int:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        subject = payload.get("sub")
        if subject is None:
            raise credentials_exception
        return int(subject)
    except (InvalidTokenError, ValueError):
        raise credentials_exception
    except Exception as exc:
        print(f"AUTH ERROR: {str(exc)}")
        logger.exception("Unexpected error while decoding access token")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication service is temporarily unavailable",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_async_session),
) -> User:
    try:
        user_id = decode_access_token(token)
        user = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if user is None:
            supabase_client = getattr(request.app.state, "supabase", None)
            if supabase_client is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Authentication service is temporarily unavailable",
                )

            user_row: dict[str, object] | None = None
            last_exception: Exception | None = None
            for attempt in range(2):
                try:
                    response = (
                        supabase_client.table("users")
                        .select("*")
                        .eq("id", user_id)
                        .maybe_single()
                        .execute()
                    )
                    user_row = _extract_supabase_row(response)
                    if user_row is not None:
                        break
                except Exception as exc:
                    last_exception = exc
                    logger.exception(
                        "Failed to fetch Supabase user by id during token hydration",
                        extra={"user_id": user_id, "attempt": attempt + 1},
                    )
                    if attempt == 0:
                        await asyncio.sleep(0.15)

            if user_row is None:
                if last_exception is not None:
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Authentication service is temporarily unavailable",
                    ) from last_exception
                raise UserNotFoundForTokenError

            try:
                user = await _sync_local_user_from_supabase_row(session=session, user_row=user_row)
            except Exception as exc:
                await session.rollback()
                logger.exception("Failed to sync local user from Supabase row", extra={"user_id": user_id})
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Authentication service is temporarily unavailable",
                ) from exc

        if user is None:
            raise UserNotFoundForTokenError
        return user
    except HTTPException:
        raise
    except UserNotFoundForTokenError:
        raise
    except Exception as exc:
        print(f"AUTH ERROR: {str(exc)}")
        logger.exception("Unexpected authentication dependency error")
        try:
            await session.rollback()
        except Exception as rollback_exc:
            print(f"AUTH ERROR: rollback failed: {str(rollback_exc)}")
            logger.exception("Failed to rollback session after auth failure")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication service is temporarily unavailable",
        ) from exc
