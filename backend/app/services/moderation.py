from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ModerationResult:
    is_allowed: bool
    reason: str | None = None


class ImageModerationService:
    """
    Placeholder servis za AI moderaciju slika.
    Kasnije se ovdje moze prikljuciti OpenAI Vision ili drugi provider.
    """

    async def moderate_profile_image(self, image_url: str) -> ModerationResult:
        _ = image_url
        return ModerationResult(is_allowed=True)
