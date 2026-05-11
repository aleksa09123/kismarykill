from __future__ import annotations

from io import BytesIO
from pathlib import Path
from uuid import uuid4

import cv2
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import create_access_token, get_current_user, hash_password, verify_password
from app.core.database import get_async_session
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
UPLOADS_DIR = Path(__file__).resolve().parents[3] / "uploads"
HAAR_CASCADE_PATH = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
FACE_NOT_DETECTED_MESSAGE = "Face not detected! Please upload a clear photo of your face to unlock PLAY."


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


def _serialize_user(user: User, rounds_played: int = 0) -> AuthUser:
    gender = user.gender or (user.pol.value if user.pol else "male")
    preferred_gender = user.preferred_gender or "both"

    normalized_gender = _normalize_gender(gender, "male")
    normalized_preference = _normalize_preferred_gender(preferred_gender)
    return AuthUser(
        id=user.id,
        email=user.email or "",
        name=user.ime,
        gender=normalized_gender,  # type: ignore[arg-type]
        preferred_gender=normalized_preference,  # type: ignore[arg-type]
        profile_image_url=user.profile_image_url or user.slika_url,
        otp_verified=bool(user.otp_verified),
        face_verified=bool(user.face_verified),
        rounds_played=rounds_played,
    )


@router.post("/register", response_model=RegisterStartResponse, status_code=status.HTTP_202_ACCEPTED)
async def register(
    payload: RegisterRequest,
    session: AsyncSession = Depends(get_async_session),
) -> RegisterStartResponse:
    print("--> MOBILE REQUEST RECEIVED")
    existing_user = (await session.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    if existing_user is not None:
        raise HTTPException(status_code=409, detail="Email is already registered")

    pending = create_pending_registration(
        email=payload.email,
        name=payload.name.strip(),
        gender=payload.gender,
        preferred_gender=payload.preferred_gender,
        profile_image_url=payload.profile_image_url,
        password_hash=hash_password(payload.password),
    )
    email_sent = send_otp_email(pending.email, pending.verification_code)
    return RegisterStartResponse(
        detail=(
            "Verification code sent to your email."
            if email_sent
            else "Registration started, but OTP email delivery failed. Please try again in a moment."
        ),
        email=pending.email,
    )


@router.post("/register/verify", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def verify_registration(
    payload: VerifyRegistrationRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AuthResponse:
    existing_user = (await session.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    if existing_user is not None:
        raise HTTPException(status_code=409, detail="Email is already registered")

    pending = get_pending_registration(payload.email)
    if pending is None:
        raise HTTPException(status_code=400, detail="No pending registration found or code expired")

    if not verify_code(payload.email, payload.code):
        raise HTTPException(status_code=400, detail="Invalid verification code")

    consumed = consume_pending_registration(payload.email)
    if consumed is None:
        raise HTTPException(status_code=400, detail="Registration session expired. Start again.")

    user = User(
        ime=consumed.name,
        slika_url=consumed.profile_image_url,
        pol=Gender(consumed.gender),
        email=consumed.email,
        password_hash=consumed.password_hash,
        gender=consumed.gender,
        preferred_gender=consumed.preferred_gender,
        profile_image_url=consumed.profile_image_url,
        otp_verified=True,
        face_verified=False,
    )
    session.add(user)

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Could not create user with this email") from exc

    await session.refresh(user)
    token = create_access_token(user.id)
    return AuthResponse(access_token=token, user=_serialize_user(user, rounds_played=0))


@router.post("/login", response_model=AuthResponse)
async def login(
    payload: LoginRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AuthResponse:
    print("--> MOBILE REQUEST RECEIVED")
    user = (await session.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_access_token(user.id)
    rounds_played = await _rounds_played(session, user.id)
    return AuthResponse(access_token=token, user=_serialize_user(user, rounds_played=rounds_played))


@router.get("/me", response_model=AuthUser)
async def get_me(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> AuthUser:
    rounds_played = await _rounds_played(session, current_user.id)
    return _serialize_user(current_user, rounds_played=rounds_played)


@router.patch("/me", response_model=AuthUser)
async def update_me(
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

    if "profile_image_url" in payload.model_fields_set:
        cleaned_url = (payload.profile_image_url or "").strip()
        current_user.profile_image_url = cleaned_url or None
        current_user.slika_url = cleaned_url or None
        current_user.face_verified = False

    await session.commit()
    await session.refresh(current_user)

    rounds_played = await _rounds_played(session, current_user.id)
    return _serialize_user(current_user, rounds_played=rounds_played)


@router.post("/upload-profile-picture", response_model=AuthUser)
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
            raise HTTPException(status_code=400, detail=FACE_NOT_DETECTED_MESSAGE)

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
        rounds_played = await _rounds_played(session, current_user.id)
        return _serialize_user(current_user, rounds_played=rounds_played)
    finally:
        await file.close()
