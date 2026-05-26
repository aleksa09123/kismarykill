from __future__ import annotations

from io import BytesIO
import logging
from pathlib import Path
from uuid import uuid4

import cv2
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Request, UploadFile, status
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from supabase import Client

from app.core.auth import create_access_token, get_current_user, hash_password, verify_password
from app.core.database import get_async_session
from app.core.location_context import normalize_location
from app.core.registration_otp import (
    create_pending_registration,
    consume_pending_registration,
    get_pending_registration,
    send_otp_email,
    verify_code,
)
from app.models.enums import Gender
from app.models.user import User
from app.models.vote import Vote
from app.schemas.auth import (
    AuthResponse,
    AuthUser,
    LoginRequest,
    RegisterRequest,
    RegisterStartResponse,
    UpdateProfileRequest,
    VerifyRegistrationRequest,
)

router = APIRouter(tags=["auth"])
logger = logging.getLogger(__name__)
UPLOADS_DIR = Path(__file__).resolve().parents[3] / "uploads"
HAAR_CASCADE_PATH = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
FACE_VERIFICATION_FAILED_MESSAGE = "Image verification failed. A valid human face must be visible."


def _image_contains_face(image: Image.Image) -> bool:
    if not HAAR_CASCADE_PATH.exists():
        raise RuntimeError(f"Face cascade model not found: {HAAR_CASCADE_PATH}")

    detector = cv2.CascadeClassifier(str(HAAR_CASCADE_PATH))
    if detector.empty():
        raise RuntimeError("Failed to initialize Haar cascade detector")

    grayscale = cv2.cvtColor(np.asarray(image, dtype=np.uint8), cv2.COLOR_RGB2GRAY)
    faces = detector.detectMultiScale(
        grayscale,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(72, 72),
    )
    return len(faces) > 0


async def _rounds_played(session: AsyncSession, user_id: int) -> int:
    votes_cast = await session.scalar(
        select(func.count(Vote.voter_id)).where(Vote.voter_id == user_id)
    )
    return int((votes_cast or 0) // 3)


def _normalize_gender(value: str | None, fallback: str) -> str:
    if value in {"male", "female"}:
        return value
    return fallback


def _normalize_preferred_gender(value: str | None) -> str:
    if value in {"male", "female", "both"}:
        return value
    return "both"


def _get_supabase_client(request: Request) -> Client:
    client = getattr(request.app.state, "supabase", None)
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Supabase client is not configured",
        )
    return client


def _extract_supabase_row(response: object) -> dict[str, object] | None:
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and data:
        first_item = data[0]
        if isinstance(first_item, dict):
            return first_item
    return None


def _normalize_enum_or_text(value: object | None, fallback: str) -> str:
    if value is None:
        return fallback
    normalized = str(value).strip().lower()
    if normalized.startswith("gender."):
        normalized = normalized.split(".", 1)[1]
    if normalized.startswith("votetype."):
        normalized = normalized.split(".", 1)[1]
    if not normalized:
        return fallback
    return normalized


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


def _fallback_name_from_email(email: str) -> str:
    local_part = email.split("@", 1)[0].strip()
    if not local_part:
        return "Player"
    candidate = local_part.replace(".", " ").replace("_", " ").strip()
    if not candidate:
        return "Player"
    return candidate[:120]


def _password_hash_from_row(user_row: dict[str, object]) -> str | None:
    password_hash = user_row.get("password_hash")
    if password_hash:
        return str(password_hash)
    hashed_password = user_row.get("hashed_password")
    if hashed_password:
        return str(hashed_password)
    return None


def _is_supabase_missing_column_error(exc: Exception) -> bool:
    message = str(exc)
    return "PGRST204" in message or "Could not find the '" in message


def _send_otp_email_background(email: str, otp: str) -> None:
    delivered = send_otp_email(email, otp)
    if not delivered:
        logger.error("OTP email delivery failed for %s", email)


def _serialize_supabase_user(user_row: dict[str, object], rounds_played: int = 0) -> AuthUser:
    gender_raw = user_row.get("gender") or user_row.get("pol")
    preferred_gender_raw = user_row.get("preferred_gender")

    normalized_gender = _normalize_gender(_normalize_enum_or_text(gender_raw, "male"), "male")
    normalized_preference = _normalize_preferred_gender(
        _normalize_enum_or_text(preferred_gender_raw, "both")
    )
    email = str(user_row.get("email") or "")
    display_name = str(user_row.get("ime") or user_row.get("name") or "").strip()
    if not display_name:
        display_name = _fallback_name_from_email(email)

    otp_verified = (
        _normalize_boolean(user_row.get("otp_verified"), default=True)
        if "otp_verified" in user_row
        else True
    )
    is_premium = (
        _normalize_boolean(user_row.get("is_premium"), default=False)
        if "is_premium" in user_row
        else _normalize_boolean(user_row.get("is_vip"), default=False)
    )

    return AuthUser(
        id=int(user_row["id"]),
        email=email,
        name=display_name,
        username=display_name,
        country_code=str(user_row.get("country_code")).upper() if user_row.get("country_code") else None,
        country_name=str(user_row.get("country_name") or "").strip() or None,
        gender=normalized_gender,  # type: ignore[arg-type]
        preferred_gender=normalized_preference,  # type: ignore[arg-type]
        profile_image_url=(
            str(user_row.get("profile_image_url"))
            if user_row.get("profile_image_url")
            else (str(user_row.get("slika_url")) if user_row.get("slika_url") else None)
        ),
        otp_verified=otp_verified,
        face_verified=_normalize_boolean(user_row.get("face_verified"), default=False),
        is_premium=is_premium,
        rounds_played=rounds_played,
    )


def _get_supabase_user_by_email(client: Client, email: str) -> dict[str, object] | None:
    response = (
        client.table("users")
        .select("*")
        .eq("email", email)
        .maybe_single()
        .execute()
    )
    return _extract_supabase_row(response)


def _best_effort_update_supabase_user(
    *,
    request: Request,
    user_id: int,
    payload: dict[str, object | None],
) -> None:
    client = getattr(request.app.state, "supabase", None)
    if client is None:
        return

    rich_payload = {
        key: value
        for key, value in payload.items()
        if value is not None
    }
    if not rich_payload:
        return

    fallback_payload = {
        key: value
        for key, value in rich_payload.items()
        if key in {"ime", "slika_url", "country_code", "password_hash"}
    }
    for candidate in (rich_payload, fallback_payload):
        if not candidate:
            continue
        try:
            client.table("users").update(candidate).eq("id", user_id).execute()
            return
        except Exception as exc:
            if not _is_supabase_missing_column_error(exc):
                logger.warning("Best-effort Supabase profile sync failed for user %s: %s", user_id, exc)
                return


def _gender_enum_from_row(user_row: dict[str, object]) -> Gender:
    normalized_gender = _normalize_gender(
        _normalize_enum_or_text(user_row.get("gender") or user_row.get("pol"), "male"),
        "male",
    )
    return Gender.female if normalized_gender == "female" else Gender.male


async def _sync_local_user_from_supabase(
    session: AsyncSession,
    user_row: dict[str, object],
) -> User:
    user_id = int(user_row["id"])
    gender_enum = _gender_enum_from_row(user_row)
    preferred_gender = _normalize_preferred_gender(
        _normalize_enum_or_text(user_row.get("preferred_gender"), "both")
    )
    profile_image_url = (
        str(user_row.get("profile_image_url"))
        if user_row.get("profile_image_url")
        else (str(user_row.get("slika_url")) if user_row.get("slika_url") else None)
    )
    password_hash = _password_hash_from_row(user_row)
    email = str(user_row.get("email") or "")
    ime = str(user_row.get("ime") or "").strip() or _fallback_name_from_email(email)
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
    if local_user is None:
        local_user = User(
            id=user_id,
            ime=ime,
            slika_url=profile_image_url,
            pol=gender_enum,
            email=email,
            password_hash=password_hash,
            gender=gender_enum.value,
            preferred_gender=preferred_gender,
            country_code=str(user_row.get("country_code")).upper() if user_row.get("country_code") else None,
            country_name=str(user_row.get("country_name") or "").strip() or None,
            profile_image_url=profile_image_url,
            otp_verified=otp_verified,
            face_verified=face_verified,
            is_premium=is_premium,
        )
        session.add(local_user)
    else:
        # Local Postgres is the runtime source of truth for editable profile fields.
        # Supabase can be stale after an upload/name change, so only hydrate blanks.
        if not local_user.ime:
            local_user.ime = ime
        if not local_user.slika_url and profile_image_url:
            local_user.slika_url = profile_image_url
        if not local_user.profile_image_url and profile_image_url:
            local_user.profile_image_url = profile_image_url
        if local_user.pol is None:
            local_user.pol = gender_enum
        local_user.email = email
        if password_hash:
            local_user.password_hash = password_hash
        if not local_user.gender:
            local_user.gender = gender_enum.value
        if not local_user.preferred_gender:
            local_user.preferred_gender = preferred_gender
        if not local_user.country_code and user_row.get("country_code"):
            local_user.country_code = str(user_row.get("country_code")).upper()
        if not local_user.country_name and user_row.get("country_name"):
            local_user.country_name = str(user_row.get("country_name") or "").strip() or None
        local_user.otp_verified = bool(local_user.otp_verified or otp_verified)
        local_user.face_verified = bool(local_user.face_verified or face_verified)
        local_user.is_premium = bool(local_user.is_premium or is_premium)

    await session.commit()
    await session.refresh(local_user)
    return local_user


def _serialize_user(user: User, rounds_played: int = 0) -> AuthUser:
    gender = user.gender or (user.pol.value if user.pol else "male")
    preferred_gender = user.preferred_gender or "both"

    normalized_gender = _normalize_gender(gender, "male")
    normalized_preference = _normalize_preferred_gender(preferred_gender)
    return AuthUser(
        id=user.id,
        email=user.email or "",
        name=user.ime,
        username=user.ime,
        country_code=user.country_code.upper() if user.country_code else None,
        country_name=user.country_name,
        gender=normalized_gender,  # type: ignore[arg-type]
        preferred_gender=normalized_preference,  # type: ignore[arg-type]
        profile_image_url=user.profile_image_url or user.slika_url,
        otp_verified=bool(user.otp_verified),
        face_verified=bool(user.face_verified),
        is_premium=bool(user.is_premium),
        rounds_played=rounds_played,
    )


@router.post("/register", response_model=RegisterStartResponse, status_code=status.HTTP_202_ACCEPTED)
@router.post("/api/register", response_model=RegisterStartResponse, status_code=status.HTTP_202_ACCEPTED)
async def register(
    request: Request,
    background_tasks: BackgroundTasks,
    payload: RegisterRequest,
) -> RegisterStartResponse:
    supabase = _get_supabase_client(request)
    password_hash = hash_password(payload.password)
    normalized_location = normalize_location(payload.country_code, payload.country_code)
    try:
        existing_user = _get_supabase_user_by_email(supabase, payload.email)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to query Supabase") from exc

    if existing_user is not None:
        raise HTTPException(status_code=409, detail="Email is already registered")

    created_user: dict[str, object] | None = None
    insert_error: Exception | None = None
    registration_payloads = [
        {
            "ime": payload.name.strip(),
            "slika_url": None,
            "pol": Gender(payload.gender).value,
            "email": payload.email,
            "password_hash": password_hash,
            "gender": payload.gender,
            "preferred_gender": payload.preferred_gender,
            "country_code": payload.country_code,
            "country_name": normalized_location.country_name,
            "profile_image_url": None,
            "otp_verified": False,
            "face_verified": False,
        },
        {
            "email": payload.email,
            "hashed_password": password_hash,
            "country_code": payload.country_code,
            "country_name": normalized_location.country_name,
        },
        {
            "email": payload.email,
            "hashed_password": password_hash,
        },
    ]
    for user_payload in registration_payloads:
        try:
            insert_response = (
                supabase.table("users")
                .insert(user_payload)
                .select("*")
                .execute()
            )
            created_user = _extract_supabase_row(insert_response)
            if created_user is not None:
                break
        except Exception as exc:
            insert_error = exc
            if _is_supabase_missing_column_error(exc):
                continue
            raise HTTPException(status_code=409, detail="Could not create user with this email") from exc

    if created_user is None:
        raise HTTPException(status_code=409, detail="Could not create user with this email") from insert_error

    pending = create_pending_registration(
        email=payload.email,
        name=payload.name.strip(),
        gender=payload.gender,
        preferred_gender=payload.preferred_gender,
        country_code=payload.country_code,
        password_hash=password_hash,
    )
    background_tasks.add_task(
        _send_otp_email_background,
        pending.email,
        pending.verification_code,
    )
    return RegisterStartResponse(
        detail="Verification code is being sent to your email.",
        email=pending.email,
    )


@router.post("/register/verify", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
@router.post("/api/register/verify", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def verify_registration(
    request: Request,
    payload: VerifyRegistrationRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AuthResponse:
    supabase = _get_supabase_client(request)
    try:
        existing_user = _get_supabase_user_by_email(supabase, payload.email)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to query Supabase") from exc

    if existing_user is None:
        raise HTTPException(status_code=400, detail="No pending registration found. Start again.")

    pending = get_pending_registration(payload.email)
    if pending is None:
        raise HTTPException(status_code=400, detail="No pending registration found or code expired")

    if not verify_code(payload.email, payload.code):
        raise HTTPException(status_code=400, detail="Invalid verification code")

    consumed = consume_pending_registration(payload.email)
    if consumed is None:
        raise HTTPException(status_code=400, detail="Registration session expired. Start again.")
    normalized_location = normalize_location(consumed.country_code, consumed.country_code)

    created_user = existing_user
    if "otp_verified" in existing_user:
        try:
            updated_response = (
                supabase.table("users")
                .update(
                    {
                        "ime": consumed.name,
                        "slika_url": None,
                        "pol": Gender(consumed.gender).value,
                        "password_hash": consumed.password_hash,
                        "gender": consumed.gender,
                        "preferred_gender": consumed.preferred_gender,
                        "country_code": consumed.country_code,
                        "country_name": normalized_location.country_name,
                        "profile_image_url": None,
                        "otp_verified": True,
                        "face_verified": False,
                    }
                )
                .eq("email", consumed.email)
                .select("*")
                .execute()
            )
            created_user = _extract_supabase_row(updated_response)
        except Exception as exc:
            if not _is_supabase_missing_column_error(exc):
                raise HTTPException(status_code=409, detail="Could not verify user with this email") from exc
            created_user = existing_user

    if created_user is None or created_user.get("id") is None:
        raise HTTPException(status_code=500, detail="Supabase did not return registered user")

    try:
        orm_user = await _sync_local_user_from_supabase(session, created_user)
    except Exception as exc:
        await session.rollback()
        raise HTTPException(status_code=500, detail="Could not sync local user profile") from exc

    token = create_access_token(int(created_user["id"]))
    return AuthResponse(access_token=token, user=_serialize_user(orm_user, rounds_played=0))


@router.post("/login", response_model=AuthResponse)
@router.post("/api/login", response_model=AuthResponse)
async def login(
    request: Request,
    payload: LoginRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AuthResponse:
    supabase = _get_supabase_client(request)

    try:
        user_row = _get_supabase_user_by_email(supabase, payload.email)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to query Supabase") from exc

    if user_row is None or not verify_password(payload.password, _password_hash_from_row(user_row) or ""):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    if "otp_verified" in user_row and not _normalize_boolean(user_row.get("otp_verified"), default=False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is not verified. Please complete OTP verification.",
        )

    user_id = int(user_row["id"])
    token = create_access_token(user_id)

    try:
        orm_user = await _sync_local_user_from_supabase(session, user_row)
    except Exception as exc:
        await session.rollback()
        raise HTTPException(status_code=500, detail="Could not sync local user profile") from exc
    rounds_played = await _rounds_played(session, orm_user.id)

    return AuthResponse(
        access_token=token,
        user=_serialize_user(orm_user, rounds_played=rounds_played),
    )


@router.get("/me", response_model=AuthUser)
@router.get("/api/me", response_model=AuthUser, include_in_schema=False)
@router.get("/users/me", response_model=AuthUser, include_in_schema=False)
@router.get("/api/users/me", response_model=AuthUser, include_in_schema=False)
async def get_me(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> AuthUser:
    rounds_played = await _rounds_played(session, current_user.id)
    return _serialize_user(current_user, rounds_played=rounds_played)


@router.patch("/me", response_model=AuthUser)
@router.patch("/api/me", response_model=AuthUser, include_in_schema=False)
@router.patch("/users/me", response_model=AuthUser, include_in_schema=False)
@router.patch("/api/users/me", response_model=AuthUser, include_in_schema=False)
async def update_me(
    request: Request,
    payload: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> AuthUser:
    if "name" in payload.model_fields_set and payload.name is not None:
        current_user.ime = payload.name.strip()

    if "gender" in payload.model_fields_set and payload.gender is not None:
        current_user.gender = payload.gender
        current_user.pol = Gender(payload.gender)

    if "preferred_gender" in payload.model_fields_set and payload.preferred_gender is not None:
        current_user.preferred_gender = payload.preferred_gender

    if "country_code" in payload.model_fields_set and payload.country_code is not None:
        normalized_location = normalize_location(payload.country_code, payload.country_code)
        current_user.country_code = payload.country_code
        current_user.country_name = normalized_location.country_name

    await session.commit()
    await session.refresh(current_user)
    _best_effort_update_supabase_user(
        request=request,
        user_id=current_user.id,
        payload={
            "ime": current_user.ime,
            "name": current_user.ime,
            "country_code": current_user.country_code,
            "country_name": current_user.country_name,
            "gender": current_user.gender,
            "preferred_gender": current_user.preferred_gender,
            "pol": current_user.pol.value if current_user.pol else None,
        },
    )

    rounds_played = await _rounds_played(session, current_user.id)
    return _serialize_user(current_user, rounds_played=rounds_played)


@router.post("/upload-profile-picture", response_model=AuthUser)
@router.post("/api/upload-profile-picture", response_model=AuthUser, include_in_schema=False)
async def upload_profile_picture(
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> AuthUser:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are allowed")

    try:
        raw_image = await file.read()
        if not raw_image:
            raise HTTPException(status_code=400, detail="Image file is empty")

        try:
            image = Image.open(BytesIO(raw_image))
        except UnidentifiedImageError as exc:
            raise HTTPException(status_code=400, detail="Invalid image file") from exc

        image = ImageOps.exif_transpose(image).convert("RGB")
        if not _image_contains_face(image):
            image.close()
            raise HTTPException(status_code=400, detail=FACE_VERIFICATION_FAILED_MESSAGE)

        image.thumbnail((800, 800), Image.Resampling.LANCZOS)

        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"user_{current_user.id}_{uuid4().hex}.jpg"
        output_path = UPLOADS_DIR / filename
        image.save(output_path, format="JPEG", quality=85, optimize=True)
        image.close()

        profile_image_url = str(request.url_for("uploads", path=filename))
        current_user.profile_image_url = profile_image_url
        current_user.slika_url = profile_image_url
        current_user.face_verified = True

        await session.commit()
        await session.refresh(current_user)
        _best_effort_update_supabase_user(
            request=request,
            user_id=current_user.id,
            payload={
                "ime": current_user.ime,
                "slika_url": profile_image_url,
                "profile_image_url": profile_image_url,
                "face_verified": True,
            },
        )
        rounds_played = await _rounds_played(session, current_user.id)
        return _serialize_user(current_user, rounds_played=rounds_played)
    finally:
        await file.close()
