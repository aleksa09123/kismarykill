from __future__ import annotations

from enum import Enum


class Gender(str, Enum):
    male = "male"
    female = "female"
    other = "other"


class PreferredGender(str, Enum):
    male = "male"
    female = "female"
    both = "both"


class VoteType(str, Enum):
    kiss = "kiss"
    marry = "marry"
    kill = "kill"
