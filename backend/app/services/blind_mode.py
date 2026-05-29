from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any

from pydantic import ValidationError

from app.core.config import settings
from app.models.user import User
from app.schemas.blind_mode import ALLOWED_AESTHETIC_THEMES, BlindModeResponse

logger = logging.getLogger(__name__)

BLIND_MODE_SYSTEM_PROMPT = """
You transform dating app profiles into anonymous Kiss, Marry, Kill Blind Mode cards.
Audience: US Gen-Z players. Tone: funny, sharp, playful, slightly edgy.
Privacy rules: never reveal names, exact locations, profile photos, emails, or direct identifiers.
Safety rules: no slurs, no hate toward protected classes, no threats, no explicit sexual content.

Return only valid JSON with exactly these string keys:
anonymous_hook, unpopular_opinion, vibe_check, aesthetic_theme.

anonymous_hook: one elegant anonymous headline, max 14 words.
unpopular_opinion: one funny controversial take, max 22 words.
vibe_check: a string with 3 short newline-separated traits, each starting with an emoji.
aesthetic_theme: choose exactly one Tailwind class from the provided allowed list.
""".strip()


def _profile_payload(profile: User) -> dict[str, object]:
    gender = profile.gender or (profile.pol.value if profile.pol else "unknown")
    return {
        "age": profile.age,
        "gender": gender,
        "interests": profile.interests or "",
        "bio": profile.bio or "",
    }


def _truncate(value: str, limit: int) -> str:
    normalized = " ".join(value.strip().split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: max(0, limit - 1)].rstrip() + "..."


def _theme_for_profile(profile: User) -> str:
    seeded = random.Random(profile.id)
    return seeded.choice(ALLOWED_AESTHETIC_THEMES)


def _fallback_response(profile: User) -> BlindModeResponse:
    gender = profile.gender or (profile.pol.value if profile.pol else "mystery")
    age_hint = f"{profile.age}-year-old " if profile.age else ""
    interests = (profile.interests or "").strip()
    bio = (profile.bio or "").strip()
    source = interests or bio or f"{age_hint}{gender} profile"

    return BlindModeResponse(
        anonymous_hook=_truncate(f"Anonymous main character with {source} energy", 180),
        unpopular_opinion="They think a chaotic group chat is a valid love language.",
        vibe_check="✨ Mystery profile energy\n🔥 Takes brunch discourse personally\n🎧 Probably has one playlist for every era",
        aesthetic_theme=_theme_for_profile(profile),
    )


def _extract_json_object(raw_text: str) -> dict[str, Any]:
    normalized = raw_text.strip()
    if normalized.startswith("```"):
        normalized = normalized.strip("`")
        if normalized.lower().startswith("json"):
            normalized = normalized[4:].strip()

    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        start = normalized.find("{")
        end = normalized.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(normalized[start : end + 1])

    if not isinstance(parsed, dict):
        raise ValueError("Gemini response was not a JSON object")
    return parsed


def _normalize_response(payload: dict[str, Any], profile: User) -> BlindModeResponse:
    candidate = BlindModeResponse.model_validate(payload)
    theme = candidate.aesthetic_theme.strip()
    if theme not in ALLOWED_AESTHETIC_THEMES:
        theme = _theme_for_profile(profile)

    return BlindModeResponse(
        anonymous_hook=_truncate(candidate.anonymous_hook, 180),
        unpopular_opinion=_truncate(candidate.unpopular_opinion, 260),
        vibe_check="\n".join(
            _truncate(line, 96)
            for line in candidate.vibe_check.splitlines()
            if line.strip()
        )[:320],
        aesthetic_theme=theme,
    )


class GeminiBlindModeService:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
    ) -> None:
        self.api_key = (api_key if api_key is not None else settings.gemini_api_key) or ""
        self.model = (model if model is not None else settings.gemini_model).strip() or "gemini-2.5-flash"

    async def anonymize_profile(self, profile: User) -> BlindModeResponse:
        if not self.api_key.strip():
            return _fallback_response(profile)

        try:
            return await asyncio.to_thread(self._generate_with_gemini, profile)
        except (ImportError, ValidationError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("Blind Mode Gemini response fell back to local generation: %s", exc)
            return _fallback_response(profile)
        except Exception as exc:
            logger.exception("Blind Mode Gemini generation failed: %s", exc)
            return _fallback_response(profile)

    def _generate_with_gemini(self, profile: User) -> BlindModeResponse:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=self.api_key)
        try:
            prompt_payload = {
                "profile": _profile_payload(profile),
                "allowed_aesthetic_themes": list(ALLOWED_AESTHETIC_THEMES),
            }
            response = client.models.generate_content(
                model=self.model,
                contents=json.dumps(prompt_payload, separators=(",", ":")),
                config=types.GenerateContentConfig(
                    system_instruction=BLIND_MODE_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    response_schema={
                        "type": "object",
                        "properties": {
                            "anonymous_hook": {"type": "string"},
                            "unpopular_opinion": {"type": "string"},
                            "vibe_check": {"type": "string"},
                            "aesthetic_theme": {
                                "type": "string",
                                "enum": list(ALLOWED_AESTHETIC_THEMES),
                            },
                        },
                        "required": [
                            "anonymous_hook",
                            "unpopular_opinion",
                            "vibe_check",
                            "aesthetic_theme",
                        ],
                    },
                    temperature=0.92,
                    max_output_tokens=420,
                ),
            )
            raw_text = getattr(response, "text", "") or ""
            return _normalize_response(_extract_json_object(raw_text), profile)
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                close()
