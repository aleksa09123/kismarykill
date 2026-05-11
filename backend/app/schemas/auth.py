from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

GenderValue = Literal["male", "female"]
PreferredGenderValue = Literal["male", "female", "both"]


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=120)
    gender: GenderValue
    preferred_gender: PreferredGenderValue = "both"
    profile_image_url: str | None = Field(default=None, max_length=500)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        lowered = value.strip().lower()
        if "@" not in lowered:
            raise ValueError("email must be valid")
        return lowered


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        lowered = value.strip().lower()
        if "@" not in lowered:
            raise ValueError("email must be valid")
        return lowered


class AuthUser(BaseModel):
    id: int
    email: str
    name: str
    gender: GenderValue
    preferred_gender: PreferredGenderValue
    profile_image_url: str | None = None
    otp_verified: bool = True
    face_verified: bool = False
    rounds_played: int = 0


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: AuthUser


class RegisterStartResponse(BaseModel):
    detail: str
    email: str
    verification_required: bool = True


class VerifyRegistrationRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    code: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        lowered = value.strip().lower()
        if "@" not in lowered:
            raise ValueError("email must be valid")
        return lowered

    @field_validator("code", mode="before")
    @classmethod
    def normalize_code(cls, value: object) -> str:
        if isinstance(value, bool):
            raise ValueError("code must be a 6-digit number")
        if isinstance(value, int):
            return f"{value:06d}"
        if isinstance(value, str):
            return value.strip()
        raise ValueError("code must be a 6-digit number")

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if len(value) != 6 or not value.isdigit():
            raise ValueError("code must be a 6-digit number")
        return value


class UpdateProfileRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    gender: GenderValue | None = None
    preferred_gender: PreferredGenderValue | None = None
    profile_image_url: str | None = Field(default=None, max_length=500)
