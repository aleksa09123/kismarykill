from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Awaitable, Callable
from uuid import uuid4

from fastapi import WebSocket

from app.core.config import settings

try:
    from redis import asyncio as redis_asyncio
except Exception:  # pragma: no cover - optional dependency for local fallback mode.
    redis_asyncio = None  # type: ignore[assignment]


LIVE_ROLES = {"judge", "contestant"}
SIGNALING_TYPES = {"offer", "answer", "ice_candidate"}

INTRO_DURATION_SECONDS = 15
BATTLE_DURATION_SECONDS = 90
JUDGMENT_DURATION_SECONDS = 15
HARD_CUTOFF_SECONDS = (
    INTRO_DURATION_SECONDS + BATTLE_DURATION_SECONDS + JUDGMENT_DURATION_SECONDS
)
COUNTRY_FALLBACK_WAIT_SECONDS = 8
DISCONNECT_GRACE_SECONDS = 12
REDIS_ROOM_TTL_SECONDS = 3600
REDIS_QUEUE_TTL_SECONDS = 3600


def _normalize_gender(value: object | None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"male", "female"}:
        return normalized
    return "unknown"


def _normalize_preferred_gender(value: object | None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"male", "female", "both"}:
        return normalized
    return "both"


def _normalize_country_code(value: object | None) -> str:
    normalized = str(value or "").strip().upper()
    if len(normalized) != 2:
        return "GL"
    return normalized


def _normalize_bool(value: object | None, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _queue_role_key(role: str) -> str:
    return f"live:queue:{role}:all"


def _queue_country_key(role: str, country_code: str) -> str:
    return f"live:queue:{role}:{country_code}"


def _queue_user_key(user_id: int) -> str:
    return f"live:queue:user:{user_id}"


def _room_key(room_id: str) -> str:
    return f"room:{room_id}"


def _room_user_key(user_id: int) -> str:
    return f"live:room:user:{user_id}"


def _datetime_to_json(value: datetime | None) -> str | None:
    if value is None:
        return None
    normalized = value.astimezone(UTC) if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return normalized.isoformat().replace("+00:00", "Z")


def _datetime_from_json(value: object | None) -> datetime | None:
    if value is None:
        return None
    try:
        normalized = str(value).strip()
        if not normalized:
            return None
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    except Exception:
        return None


def _preference_allows(preferred_gender: str, actual_gender: str) -> bool:
    if preferred_gender == "both":
        return True
    if actual_gender == "unknown":
        return True
    return preferred_gender == actual_gender


@dataclass(frozen=True)
class LiveQueueEntry:
    user_id: int
    role: str
    gender: str
    preferred_gender: str
    country_code: str
    enqueued_at: datetime


@dataclass
class LiveRoom:
    room_id: str
    judge_entry: LiveQueueEntry
    contestant_entries: tuple[LiveQueueEntry, LiveQueueEntry, LiveQueueEntry]
    created_at: datetime
    phase: str = "MATCH_FOUND"
    started_at: datetime | None = None
    phase_ends_at: datetime | None = None
    decision_event: asyncio.Event = field(default_factory=asyncio.Event)
    phase_task: asyncio.Task[None] | None = None

    @property
    def judge_id(self) -> int:
        return self.judge_entry.user_id

    @property
    def contestant_ids(self) -> tuple[int, int, int]:
        return tuple(entry.user_id for entry in self.contestant_entries)  # type: ignore[return-value]

    @property
    def participant_entries(self) -> tuple[LiveQueueEntry, ...]:
        return (self.judge_entry, *self.contestant_entries)

    @property
    def participant_ids(self) -> tuple[int, ...]:
        return tuple(entry.user_id for entry in self.participant_entries)

    def entry_for_user(self, user_id: int) -> LiveQueueEntry | None:
        for entry in self.participant_entries:
            if entry.user_id == user_id:
                return entry
        return None


def _queue_entry_to_dict(entry: LiveQueueEntry) -> dict[str, object]:
    return {
        "user_id": entry.user_id,
        "role": entry.role,
        "gender": entry.gender,
        "preferred_gender": entry.preferred_gender,
        "country_code": entry.country_code,
        "enqueued_at": _datetime_to_json(entry.enqueued_at),
    }


def _queue_entry_from_dict(data: object) -> LiveQueueEntry | None:
    if not isinstance(data, dict):
        return None
    try:
        user_id = int(data.get("user_id", data.get("userId")))  # type: ignore[arg-type]
    except Exception:
        return None

    role = str(data.get("role") or "").strip().lower()
    if role not in LIVE_ROLES:
        return None

    return LiveQueueEntry(
        user_id=user_id,
        role=role,
        gender=_normalize_gender(data.get("gender")),
        preferred_gender=_normalize_preferred_gender(
            data.get("preferred_gender", data.get("preferredGender")),
        ),
        country_code=_normalize_country_code(data.get("country_code", data.get("countryCode"))),
        enqueued_at=_datetime_from_json(data.get("enqueued_at", data.get("enqueuedAt")))
        or datetime.now(UTC),
    )


def _room_to_dict(room: LiveRoom) -> dict[str, object]:
    return {
        "room_id": room.room_id,
        "judge_entry": _queue_entry_to_dict(room.judge_entry),
        "contestant_entries": [
            _queue_entry_to_dict(entry) for entry in room.contestant_entries
        ],
        "created_at": _datetime_to_json(room.created_at),
        "phase": room.phase,
        "started_at": _datetime_to_json(room.started_at),
        "phase_ends_at": _datetime_to_json(room.phase_ends_at),
    }


def _room_from_dict(data: object) -> LiveRoom | None:
    if not isinstance(data, dict):
        return None

    room_id = str(data.get("room_id", data.get("roomId")) or "").strip()
    if not room_id:
        return None

    judge_entry = _queue_entry_from_dict(data.get("judge_entry", data.get("judgeEntry")))
    raw_contestant_entries = data.get(
        "contestant_entries",
        data.get("contestantEntries", []),
    )
    if not isinstance(raw_contestant_entries, list):
        return None
    contestant_entries = [
        entry
        for entry in (
            _queue_entry_from_dict(raw_entry) for raw_entry in raw_contestant_entries
        )
        if entry is not None
    ]
    if judge_entry is None or len(contestant_entries) != 3:
        return None

    return LiveRoom(
        room_id=room_id,
        judge_entry=judge_entry,
        contestant_entries=tuple(contestant_entries),  # type: ignore[arg-type]
        created_at=_datetime_from_json(data.get("created_at", data.get("createdAt")))
        or datetime.now(UTC),
        phase=str(data.get("phase") or "MATCH_FOUND"),
        started_at=_datetime_from_json(data.get("started_at", data.get("startedAt"))),
        phase_ends_at=_datetime_from_json(
            data.get("phase_ends_at", data.get("phaseEndsAt")),
        ),
    )


class LiveConnectionManager:
    def __init__(self) -> None:
        self._state_lock = asyncio.Lock()
        self._active_connections: dict[int, WebSocket] = {}
        self._judge_queue: list[LiveQueueEntry] = []
        self._contestant_queue: list[LiveQueueEntry] = []
        self._queue_by_user_id: dict[int, LiveQueueEntry] = {}
        self._rooms_by_id: dict[str, LiveRoom] = {}
        self._room_by_user_id: dict[int, str] = {}
        self._fallback_match_task: asyncio.Task[None] | None = None
        self._disconnect_grace_tasks: dict[int, asyncio.Task[None]] = {}
        self._redis_deleted_room_ids: set[str] = set()
        self._redis_deleted_room_user_ids: set[int] = set()
        self._redis: Any | None = None

        redis_url = (settings.redis_url or "").strip()
        if redis_url and redis_asyncio is not None:
            self._redis = redis_asyncio.from_url(redis_url, decode_responses=True)
        elif redis_url and redis_asyncio is None:
            print("LIVE REDIS disabled: redis package is not installed. Falling back to in-memory state.")

    async def close(self) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.aclose()
        except Exception:
            pass

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        previous_socket: WebSocket | None = None
        pending_disconnect: asyncio.Task[None] | None = None
        async with self._state_lock:
            pending_disconnect = self._disconnect_grace_tasks.pop(user_id, None)
            previous_socket = self._active_connections.get(user_id)
            self._active_connections[user_id] = websocket

        if pending_disconnect is not None:
            pending_disconnect.cancel()

        if previous_socket is not None and previous_socket is not websocket:
            try:
                await previous_socket.close(code=1000)
            except Exception:
                pass

        await self._send_to_user(
            user_id,
            {
                "type": "connected",
                "user_id": user_id,
            },
        )

    async def disconnect(self, user_id: int, websocket: WebSocket | None = None) -> None:
        async with self._state_lock:
            if websocket is not None and self._active_connections.get(user_id) is not websocket:
                return
            self._active_connections.pop(user_id, None)
            existing_task = self._disconnect_grace_tasks.pop(user_id, None)
            if existing_task is not None:
                existing_task.cancel()
            self._disconnect_grace_tasks[user_id] = asyncio.create_task(
                self._run_disconnect_grace(user_id),
                name=f"live-disconnect-grace-{user_id}",
            )

    async def _run_disconnect_grace(self, user_id: int) -> None:
        try:
            await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
            notifications: list[tuple[int, dict[str, object]]] = []
            room_ids_to_start: list[str] = []
            async with self._state_lock:
                if user_id in self._active_connections:
                    self._disconnect_grace_tasks.pop(user_id, None)
                    return

                current_task = asyncio.current_task()
                if self._disconnect_grace_tasks.get(user_id) is current_task:
                    self._disconnect_grace_tasks.pop(user_id, None)

                await self._refresh_queue_from_redis_locked()
                notifications, room_ids_to_start = self._cleanup_disconnected_user_locked(user_id)

            await self._flush_redis_state(room_ids_to_persist=room_ids_to_start)
            await self._fanout_notifications(notifications)
            await self._start_room_loops(room_ids_to_start)
        except asyncio.CancelledError:
            return

    def _cleanup_disconnected_user_locked(self, user_id: int) -> tuple[list[tuple[int, dict[str, object]]], list[str]]:
        notifications: list[tuple[int, dict[str, object]]] = []
        room_ids_to_start: list[str] = []
        self._remove_from_queue_locked(user_id)

        room_id = self._room_by_user_id.get(user_id)
        if room_id is not None:
            room = self._rooms_by_id.get(room_id)
            if room is not None:
                for participant_id in room.participant_ids:
                    if participant_id == user_id:
                        continue
                    notifications.append(
                        (
                            participant_id,
                            {
                                "type": "room_member_left",
                                "room_id": room_id,
                                "roomId": room_id,
                                "user_id": user_id,
                                "userId": user_id,
                            },
                        )
                    )

            close_notifications, new_room_ids = self._close_room_locked(
                room_id=room_id,
                reason="participant_disconnected",
                requeue_connected=True,
                excluded_requeue_user_ids={user_id},
            )
            notifications.extend(close_notifications)
            room_ids_to_start.extend(new_room_ids)

        return notifications, room_ids_to_start

    async def join_queue(
        self,
        *,
        user_id: int,
        role: str,
        gender: object | None = None,
        preferred_gender: object | None = None,
        country_code: object | None = None,
    ) -> None:
        normalized_role = str(role or "").strip().lower()
        if normalized_role not in LIVE_ROLES:
            await self._send_to_user(
                user_id,
                {
                    "type": "error",
                    "detail": "invalid_role",
                    "allowed_roles": sorted(LIVE_ROLES),
                },
            )
            return

        immediate_error: dict[str, object] | None = None
        notifications: list[tuple[int, dict[str, object]]] = []
        room_ids_to_start: list[str] = []
        async with self._state_lock:
            await self._refresh_queue_from_redis_locked()
            self._remove_from_queue_locked(user_id)

            if user_id in self._room_by_user_id:
                immediate_error = {
                    "type": "error",
                    "detail": "already_in_room",
                }
            else:
                entry = LiveQueueEntry(
                    user_id=user_id,
                    role=normalized_role,
                    gender=_normalize_gender(gender),
                    preferred_gender=_normalize_preferred_gender(preferred_gender),
                    country_code=_normalize_country_code(country_code),
                    enqueued_at=datetime.now(UTC),
                )
                if normalized_role == "judge":
                    self._judge_queue.append(entry)
                else:
                    self._contestant_queue.append(entry)
                self._queue_by_user_id[user_id] = entry

                notifications.append(
                    (
                        user_id,
                        {
                            "type": "queue_joined",
                            "action": "queue_joined",
                            "role": entry.role,
                            "gender": entry.gender,
                            "preferred_gender": entry.preferred_gender,
                            "preferredGender": entry.preferred_gender,
                            "country_code": entry.country_code,
                            "countryCode": entry.country_code,
                        },
                    )
                )

                match_notifications, matched_room_ids = self._consume_ready_rooms_locked()
                notifications.extend(match_notifications)
                room_ids_to_start.extend(matched_room_ids)
                self._schedule_fallback_match_locked()

        await self._flush_redis_state(room_ids_to_persist=room_ids_to_start)

        if immediate_error is not None:
            await self._send_to_user(user_id, immediate_error)
            return

        await self._fanout_notifications(notifications)
        await self._start_room_loops(room_ids_to_start)

    async def leave_queue(self, *, user_id: int) -> bool:
        removed = False
        notifications: list[tuple[int, dict[str, object]]] = []
        room_ids_to_start: list[str] = []
        async with self._state_lock:
            await self._refresh_queue_from_redis_locked()
            pending_disconnect = self._disconnect_grace_tasks.pop(user_id, None)
            if pending_disconnect is not None:
                pending_disconnect.cancel()
            removed = self._remove_from_queue_locked(user_id)
            room_id = self._room_by_user_id.get(user_id)
            if room_id is not None:
                close_notifications, new_room_ids = self._close_room_locked(
                    room_id=room_id,
                    reason="participant_left",
                    requeue_connected=True,
                    excluded_requeue_user_ids={user_id},
                )
                notifications.extend(close_notifications)
                room_ids_to_start.extend(new_room_ids)
            self._schedule_fallback_match_locked()

        await self._flush_redis_state(room_ids_to_persist=room_ids_to_start)

        await self._send_to_user(
            user_id,
            {
                "type": "queue_left",
                "action": "queue_left",
                "removed": removed,
            },
        )
        await self._fanout_notifications(notifications)
        await self._start_room_loops(room_ids_to_start)
        return removed

    async def resume_room(self, *, user_id: int, room_id: object | None = None) -> None:
        requested_room_id = str(room_id or "").strip()
        await self._restore_room_for_user_from_redis(
            user_id=user_id,
            requested_room_id=requested_room_id or None,
        )
        payload: dict[str, object] | None = None
        room_id_to_resume: str | None = None
        async with self._state_lock:
            active_room_id = self._room_by_user_id.get(user_id)
            if active_room_id is None:
                payload = {
                    "type": "room_resume_failed",
                    "reason": "room_not_found",
                }
            elif requested_room_id and requested_room_id != active_room_id:
                payload = {
                    "type": "room_resume_failed",
                    "reason": "room_mismatch",
                    "room_id": active_room_id,
                    "roomId": active_room_id,
                }
            else:
                room = self._rooms_by_id.get(active_room_id)
                if room is None:
                    payload = {
                        "type": "room_resume_failed",
                        "reason": "room_not_found",
                    }
                else:
                    participant_ids = list(room.participant_ids)
                    phase_seconds_left = 0
                    if room.phase_ends_at is not None:
                        phase_seconds_left = max(
                            0,
                            int((room.phase_ends_at - datetime.now(UTC)).total_seconds()),
                        )
                    entry = room.entry_for_user(user_id)
                    room_id_to_resume = room.room_id
                    payload = {
                        "type": "room_state",
                        "room_id": room.room_id,
                        "roomId": room.room_id,
                        "role": entry.role if entry is not None else None,
                        "phase": room.phase,
                        "duration": phase_seconds_left,
                        "participants": participant_ids,
                        "participant_ids": participant_ids,
                        "judge_id": room.judge_id,
                        "judgeId": room.judge_id,
                    }

        if payload is not None:
            await self._send_to_user(user_id, payload)
        if room_id_to_resume is not None:
            await self._start_room_loop(room_id_to_resume)

    async def relay_signaling_message(
        self,
        *,
        from_user_id: int,
        payload: dict[str, object],
    ) -> None:
        message_type = str(payload.get("type") or "").strip().lower()
        if message_type not in SIGNALING_TYPES:
            await self._send_to_user(
                from_user_id,
                {
                    "type": "error",
                    "detail": "invalid_signal_type",
                    "allowed_types": sorted(SIGNALING_TYPES),
                },
            )
            return

        target_raw = payload.get("target_user_id", payload.get("targetUserId"))
        try:
            target_user_id = int(target_raw)  # type: ignore[arg-type]
        except Exception:
            await self._send_to_user(
                from_user_id,
                {
                    "type": "error",
                    "detail": "invalid_target_user_id",
                },
            )
            return

        room_hint = payload.get("room_id", payload.get("roomId"))
        restored_room_id = await self._restore_room_for_user_from_redis(
            user_id=from_user_id,
            requested_room_id=room_hint,
        )
        if restored_room_id is not None:
            await self._start_room_loop(restored_room_id)
        restored_target_room_id = await self._restore_room_for_user_from_redis(
            user_id=target_user_id,
            requested_room_id=room_hint,
        )
        if restored_target_room_id is not None:
            await self._start_room_loop(restored_target_room_id)

        relay_payload: dict[str, object] | None = None
        error_payload: dict[str, object] | None = None

        async with self._state_lock:
            room_id = self._room_by_user_id.get(from_user_id)
            target_room_id = self._room_by_user_id.get(target_user_id)
            if room_id is None or target_room_id is None or room_id != target_room_id:
                error_payload = {
                    "type": "error",
                    "detail": "target_not_in_same_room",
                }
            else:
                room = self._rooms_by_id.get(room_id)
                if room is None:
                    error_payload = {
                        "type": "error",
                        "detail": "room_not_found",
                    }
                elif target_user_id not in room.participant_ids:
                    error_payload = {
                        "type": "error",
                        "detail": "target_not_in_room",
                    }
                else:
                    relay_payload = {
                        "type": message_type,
                        "room_id": room_id,
                        "from_user_id": from_user_id,
                        "fromUserId": from_user_id,
                        "target_user_id": target_user_id,
                        "targetUserId": target_user_id,
                        "sdp": payload.get("sdp"),
                        "candidate": payload.get("candidate"),
                        "mid": payload.get("mid"),
                        "mline_index": payload.get("mline_index", payload.get("mlineIndex")),
                        "mlineIndex": payload.get("mline_index", payload.get("mlineIndex")),
                    }

        if error_payload is not None:
            await self._send_to_user(from_user_id, error_payload)
            return
        if relay_payload is None:
            await self._send_to_user(
                from_user_id,
                {
                    "type": "error",
                    "detail": "relay_payload_missing",
                },
            )
            return
        await self._send_to_user(target_user_id, relay_payload)

    async def submit_judge_kill_action(
        self,
        *,
        judge_user_id: int,
        payload: dict[str, object],
    ) -> None:
        target_user_id: int | None = None
        participants: tuple[int, ...] | None = None
        error_payload: dict[str, object] | None = None
        should_mark_complete = _normalize_bool(
            payload.get(
                "round_complete",
                payload.get("roundComplete", payload.get("is_final", payload.get("finalize"))),
            ),
            default=True,
        )

        target_raw = payload.get(
            "target_user_id",
            payload.get("targetUserId", payload.get("user_id", payload.get("userId"))),
        )
        try:
            target_user_id = int(target_raw)  # type: ignore[arg-type]
        except Exception:
            await self._send_to_user(
                judge_user_id,
                {
                    "type": "error",
                    "detail": "invalid_target_user_id",
                },
            )
            return

        restored_room_id = await self._restore_room_for_user_from_redis(
            user_id=judge_user_id,
            requested_room_id=payload.get("room_id", payload.get("roomId")),
        )
        if restored_room_id is not None:
            await self._start_room_loop(restored_room_id)

        async with self._state_lock:
            room_id = self._room_by_user_id.get(judge_user_id)
            if room_id is None:
                error_payload = {
                    "type": "error",
                    "detail": "judge_not_in_room",
                }
            room = self._rooms_by_id.get(room_id)
            if error_payload is None:
                if room is None:
                    error_payload = {
                        "type": "error",
                        "detail": "room_not_found",
                    }
                elif room.judge_id != judge_user_id:
                    error_payload = {
                        "type": "error",
                        "detail": "only_judge_can_eliminate",
                    }
                elif target_user_id not in room.contestant_ids:
                    error_payload = {
                        "type": "error",
                        "detail": "target_must_be_contestant",
                    }
                else:
                    participants = room.participant_ids
                    if should_mark_complete:
                        room.decision_event.set()

        if error_payload is not None:
            await self._send_to_user(judge_user_id, error_payload)
            return

        if participants is None or target_user_id is None:
            return

        notifications: list[tuple[int, dict[str, object]]] = []
        for participant_id in participants:
            if participant_id == target_user_id:
                continue
            notifications.append(
                (
                    participant_id,
                    {
                        "type": "user_eliminated",
                        "user_id": target_user_id,
                        "userId": target_user_id,
                    },
                )
            )
        await self._fanout_notifications(notifications)

    async def mark_judgment_complete(self, *, judge_user_id: int) -> None:
        error_payload: dict[str, object] | None = None
        restored_room_id = await self._restore_room_for_user_from_redis(user_id=judge_user_id)
        if restored_room_id is not None:
            await self._start_room_loop(restored_room_id)
        async with self._state_lock:
            room_id = self._room_by_user_id.get(judge_user_id)
            if room_id is None:
                error_payload = {
                    "type": "error",
                    "detail": "judge_not_in_room",
                }
            room = self._rooms_by_id.get(room_id)
            if error_payload is None:
                if room is None:
                    error_payload = {
                        "type": "error",
                        "detail": "room_not_found",
                    }
                elif room.judge_id != judge_user_id:
                    error_payload = {
                        "type": "error",
                        "detail": "only_judge_can_finalize",
                    }
                else:
                    room.decision_event.set()

        if error_payload is not None:
            await self._send_to_user(judge_user_id, error_payload)
            return

        await self._send_to_user(
            judge_user_id,
            {
                "type": "judgment_marked_complete",
                "action": "judgment_marked_complete",
            },
        )

    async def _start_room_loops(self, room_ids: list[str]) -> None:
        for room_id in room_ids:
            await self._start_room_loop(room_id)

    async def _start_room_loop(self, room_id: str) -> None:
        async with self._state_lock:
            room = self._rooms_by_id.get(room_id)
            if room is None:
                return
            if room.phase_task is not None and not room.phase_task.done():
                return
            room_loop = (
                self._run_resumed_room_game_loop(room_id)
                if room.phase in {"INTRO", "BATTLE", "JUDGMENT"}
                else self._run_room_game_loop(room_id)
            )
            room.phase_task = asyncio.create_task(
                room_loop,
                name=f"live-room-loop-{room_id}",
            )

    async def _run_room_game_loop(self, room_id: str) -> None:
        try:
            room = await self._set_room_phase(
                room_id=room_id,
                phase="INTRO",
                duration=INTRO_DURATION_SECONDS,
            )
            if room is None:
                return
            if not await self._sleep_if_room_active(room_id, INTRO_DURATION_SECONDS):
                return

            room = await self._set_room_phase(
                room_id=room_id,
                phase="BATTLE",
                duration=BATTLE_DURATION_SECONDS,
            )
            if room is None:
                return
            if not await self._sleep_if_room_active(room_id, BATTLE_DURATION_SECONDS):
                return

            room = await self._set_room_phase(
                room_id=room_id,
                phase="JUDGMENT",
                duration=JUDGMENT_DURATION_SECONDS,
            )
            if room is None:
                return

            await self._finish_judgment_phase(
                room_id=room_id,
                room=room,
                timeout_seconds=JUDGMENT_DURATION_SECONDS,
            )
            return
        except asyncio.CancelledError:
            return
        except Exception as exc:
            print(f"LIVE LOOP ERROR ({room_id}): {str(exc)}")
            notifications, room_ids_to_start = await self._close_room(
                room_id=room_id,
                reason="runtime_error",
                requeue_connected=True,
            )
            await self._fanout_notifications(notifications)
            await self._start_room_loops(room_ids_to_start)

    async def _run_resumed_room_game_loop(self, room_id: str) -> None:
        try:
            async with self._state_lock:
                room = self._rooms_by_id.get(room_id)
                if room is None:
                    return
                phase = room.phase
                phase_ends_at = room.phase_ends_at

            if phase == "MATCH_FOUND":
                await self._run_room_game_loop(room_id)
                return

            remaining_seconds = 0
            if phase_ends_at is not None:
                remaining_seconds = max(
                    0,
                    int((phase_ends_at - datetime.now(UTC)).total_seconds()),
                )

            if phase == "INTRO":
                if remaining_seconds > 0 and not await self._sleep_if_room_active(
                    room_id,
                    remaining_seconds,
                ):
                    return
                room = await self._set_room_phase(
                    room_id=room_id,
                    phase="BATTLE",
                    duration=BATTLE_DURATION_SECONDS,
                )
                if room is None:
                    return
                if not await self._sleep_if_room_active(room_id, BATTLE_DURATION_SECONDS):
                    return
                room = await self._set_room_phase(
                    room_id=room_id,
                    phase="JUDGMENT",
                    duration=JUDGMENT_DURATION_SECONDS,
                )
                if room is None:
                    return
                await self._finish_judgment_phase(
                    room_id=room_id,
                    room=room,
                    timeout_seconds=JUDGMENT_DURATION_SECONDS,
                )
                return

            if phase == "BATTLE":
                if remaining_seconds > 0 and not await self._sleep_if_room_active(
                    room_id,
                    remaining_seconds,
                ):
                    return
                room = await self._set_room_phase(
                    room_id=room_id,
                    phase="JUDGMENT",
                    duration=JUDGMENT_DURATION_SECONDS,
                )
                if room is None:
                    return
                await self._finish_judgment_phase(
                    room_id=room_id,
                    room=room,
                    timeout_seconds=JUDGMENT_DURATION_SECONDS,
                )
                return

            if phase == "JUDGMENT":
                async with self._state_lock:
                    room = self._rooms_by_id.get(room_id)
                if room is None:
                    return
                await self._finish_judgment_phase(
                    room_id=room_id,
                    room=room,
                    timeout_seconds=remaining_seconds,
                )
        except asyncio.CancelledError:
            return
        except Exception as exc:
            print(f"LIVE RESUME LOOP ERROR ({room_id}): {str(exc)}")
            notifications, room_ids_to_start = await self._close_room(
                room_id=room_id,
                reason="runtime_error",
                requeue_connected=True,
            )
            await self._fanout_notifications(notifications)
            await self._start_room_loops(room_ids_to_start)

    async def _finish_judgment_phase(
        self,
        *,
        room_id: str,
        room: LiveRoom,
        timeout_seconds: int,
    ) -> None:
        try:
            await asyncio.wait_for(
                room.decision_event.wait(),
                timeout=max(0, timeout_seconds),
            )
            await self._broadcast_to_room(
                room_id,
                {
                    "type": "round_completed",
                    "action": "round_completed",
                    "reason": "judge_decision_received",
                },
            )
            notifications, room_ids_to_start = await self._close_room(
                room_id=room_id,
                reason="round_completed",
                requeue_connected=True,
            )
            await self._fanout_notifications(notifications)
            await self._start_room_loops(room_ids_to_start)
        except asyncio.TimeoutError:
            await self._broadcast_to_room(
                room_id,
                {
                    "type": "force_skip",
                    "action": "force_skip",
                    "reason": "time_expired",
                    "hard_cutoff_seconds": HARD_CUTOFF_SECONDS,
                    "hardCutoffSeconds": HARD_CUTOFF_SECONDS,
                },
            )
            notifications, room_ids_to_start = await self._close_room(
                room_id=room_id,
                reason="time_expired",
                requeue_connected=True,
            )
            await self._fanout_notifications(notifications)
            await self._start_room_loops(room_ids_to_start)

    async def _set_room_phase(
        self,
        *,
        room_id: str,
        phase: str,
        duration: int,
    ) -> LiveRoom | None:
        async with self._state_lock:
            room = self._rooms_by_id.get(room_id)
            if room is None:
                return None
            now = datetime.now(UTC)
            room.phase = phase
            if phase == "INTRO" and room.started_at is None:
                room.started_at = now
            room.phase_ends_at = now + timedelta(seconds=max(0, duration))
            participant_ids = room.participant_ids

        await self._persist_rooms_by_ids([room_id])

        notifications = [
            (
                participant_id,
                {
                    "type": "phase_change",
                    "phase": phase,
                    "duration": duration,
                    "room_id": room_id,
                    "roomId": room_id,
                },
            )
            for participant_id in participant_ids
        ]
        await self._fanout_notifications(notifications)

        async with self._state_lock:
            return self._rooms_by_id.get(room_id)

    async def _sleep_if_room_active(self, room_id: str, duration: int) -> bool:
        await asyncio.sleep(duration)
        async with self._state_lock:
            return room_id in self._rooms_by_id

    async def _broadcast_to_room(
        self,
        room_id: str,
        payload: dict[str, object],
        *,
        exclude_user_ids: set[int] | None = None,
    ) -> None:
        if exclude_user_ids is None:
            exclude_user_ids = set()

        async with self._state_lock:
            room = self._rooms_by_id.get(room_id)
            if room is None:
                return
            targets = [pid for pid in room.participant_ids if pid not in exclude_user_ids]

        notifications = [(participant_id, payload) for participant_id in targets]
        await self._fanout_notifications(notifications)

    async def _close_room(
        self,
        *,
        room_id: str,
        reason: str,
        requeue_connected: bool,
        excluded_requeue_user_ids: set[int] | None = None,
    ) -> tuple[list[tuple[int, dict[str, object]]], list[str]]:
        async with self._state_lock:
            notifications, room_ids_to_start = self._close_room_locked(
                room_id=room_id,
                reason=reason,
                requeue_connected=requeue_connected,
                excluded_requeue_user_ids=excluded_requeue_user_ids,
            )
        await self._flush_redis_state(room_ids_to_persist=room_ids_to_start)
        return notifications, room_ids_to_start

    def _close_room_locked(
        self,
        *,
        room_id: str,
        reason: str,
        requeue_connected: bool,
        excluded_requeue_user_ids: set[int] | None = None,
    ) -> tuple[list[tuple[int, dict[str, object]]], list[str]]:
        room = self._rooms_by_id.pop(room_id, None)
        if room is None:
            return [], []

        self._redis_deleted_room_ids.add(room_id)
        self._redis_deleted_room_user_ids.update(room.participant_ids)

        current_task = asyncio.current_task()
        if room.phase_task is not None and room.phase_task is not current_task:
            room.phase_task.cancel()

        for participant_id in room.participant_ids:
            self._room_by_user_id.pop(participant_id, None)

        excluded = excluded_requeue_user_ids or set()
        notifications: list[tuple[int, dict[str, object]]] = []
        if requeue_connected:
            for entry in room.participant_entries:
                if entry.user_id in excluded:
                    continue
                if entry.user_id not in self._active_connections:
                    continue
                if entry.user_id in self._queue_by_user_id:
                    continue
                if entry.user_id in self._room_by_user_id:
                    continue

                if entry.role == "judge":
                    requeue_entry = replace(entry, enqueued_at=datetime.now(UTC))
                    self._judge_queue.append(requeue_entry)
                else:
                    requeue_entry = replace(entry, enqueued_at=datetime.now(UTC))
                    self._contestant_queue.append(requeue_entry)
                self._queue_by_user_id[requeue_entry.user_id] = requeue_entry
                notifications.append(
                    (
                        requeue_entry.user_id,
                        {
                            "type": "queue_rejoined",
                            "action": "queue_rejoined",
                            "reason": reason,
                            "role": requeue_entry.role,
                        },
                    )
                )

        match_notifications, room_ids_to_start = self._consume_ready_rooms_locked()
        notifications.extend(match_notifications)
        self._schedule_fallback_match_locked()
        return notifications, room_ids_to_start

    async def _fanout_notifications(self, notifications: list[tuple[int, dict[str, object]]]) -> None:
        if not notifications:
            return
        for target_user_id, payload in notifications:
            await self._send_to_user(target_user_id, payload)

    async def _send_to_user(self, user_id: int, payload: dict[str, object]) -> None:
        websocket = self._active_connections.get(user_id)
        if websocket is None:
            return
        try:
            await websocket.send_json(payload)
        except Exception:
            async with self._state_lock:
                current_socket = self._active_connections.get(user_id)
                if current_socket is websocket:
                    self._active_connections.pop(user_id, None)

    async def _redis_call(
        self,
        operation_name: str,
        operation: Callable[[Any], Awaitable[Any]],
    ) -> Any | None:
        redis_client = self._redis
        if redis_client is None:
            return None

        try:
            return await operation(redis_client)
        except Exception as exc:
            print(
                f"LIVE REDIS {operation_name} failed; falling back to in-memory state: {str(exc)}"
            )
            self._redis = None
            return None

    async def _refresh_queue_from_redis_locked(self) -> None:
        entries = await self._load_queue_entries_from_redis()
        if entries is None:
            return
        self._replace_queue_entries_locked(entries)

    async def _load_queue_entries_from_redis(self) -> list[LiveQueueEntry] | None:
        async def operation(redis_client: Any) -> list[LiveQueueEntry]:
            keys: list[str] = []
            async for key in redis_client.scan_iter(match="live:queue:user:*", count=100):
                keys.append(str(key))
            if not keys:
                return []

            values = await redis_client.mget(keys)
            entries: list[LiveQueueEntry] = []
            for raw_value in values:
                if not raw_value:
                    continue
                try:
                    loaded = json.loads(str(raw_value))
                except Exception:
                    continue
                entry = _queue_entry_from_dict(loaded)
                if entry is not None:
                    entries.append(entry)
            return entries

        return await self._redis_call("load_queue", operation)

    def _replace_queue_entries_locked(self, entries: list[LiveQueueEntry]) -> None:
        active_user_ids = set(self._active_connections)
        deduped: dict[int, LiveQueueEntry] = {}
        for entry in sorted(entries, key=lambda item: item.enqueued_at):
            if entry.user_id not in active_user_ids:
                continue
            if entry.user_id in self._room_by_user_id:
                continue

            existing_entry = deduped.get(entry.user_id)
            if existing_entry is None or entry.enqueued_at >= existing_entry.enqueued_at:
                deduped[entry.user_id] = entry

        sorted_entries = sorted(deduped.values(), key=lambda item: item.enqueued_at)
        self._queue_by_user_id = {entry.user_id: entry for entry in sorted_entries}
        self._judge_queue = [entry for entry in sorted_entries if entry.role == "judge"]
        self._contestant_queue = [
            entry for entry in sorted_entries if entry.role == "contestant"
        ]

    async def _persist_queue_to_redis(self) -> None:
        if self._redis is None:
            return
        async with self._state_lock:
            entries = [*self._judge_queue, *self._contestant_queue]
        await self._persist_queue_entries_to_redis(entries)

    async def _persist_queue_entries_to_redis(self, entries: list[LiveQueueEntry]) -> None:
        if self._redis is None:
            return

        async def operation(redis_client: Any) -> bool:
            keys: list[str] = []
            async for key in redis_client.scan_iter(match="live:queue:*", count=100):
                keys.append(str(key))

            if not keys and not entries:
                return True

            pipe = redis_client.pipeline()
            if keys:
                pipe.delete(*keys)

            for entry in entries:
                payload = json.dumps(
                    _queue_entry_to_dict(entry),
                    separators=(",", ":"),
                    sort_keys=True,
                )
                score = entry.enqueued_at.timestamp()
                role_key = _queue_role_key(entry.role)
                country_key = _queue_country_key(entry.role, entry.country_code)
                pipe.zadd(role_key, {payload: score})
                pipe.zadd(country_key, {payload: score})
                pipe.set(_queue_user_key(entry.user_id), payload, ex=REDIS_QUEUE_TTL_SECONDS)
                pipe.expire(role_key, REDIS_QUEUE_TTL_SECONDS)
                pipe.expire(country_key, REDIS_QUEUE_TTL_SECONDS)

            await pipe.execute()
            return True

        await self._redis_call("persist_queue", operation)

    async def _persist_rooms_by_ids(self, room_ids: list[str]) -> None:
        if self._redis is None or not room_ids:
            return
        unique_room_ids = sorted(set(room_ids))
        async with self._state_lock:
            rooms = [
                self._rooms_by_id[room_id]
                for room_id in unique_room_ids
                if room_id in self._rooms_by_id
            ]
        await self._persist_room_snapshots_to_redis(rooms)

    async def _persist_room_snapshots_to_redis(self, rooms: list[LiveRoom]) -> None:
        if self._redis is None or not rooms:
            return

        async def operation(redis_client: Any) -> bool:
            pipe = redis_client.pipeline()
            for room in rooms:
                payload = json.dumps(
                    _room_to_dict(room),
                    separators=(",", ":"),
                    sort_keys=True,
                )
                pipe.set(_room_key(room.room_id), payload, ex=REDIS_ROOM_TTL_SECONDS)
                for participant_id in room.participant_ids:
                    pipe.set(
                        _room_user_key(participant_id),
                        room.room_id,
                        ex=REDIS_ROOM_TTL_SECONDS,
                    )
            await pipe.execute()
            return True

        await self._redis_call("persist_rooms", operation)

    async def _delete_rooms_from_redis(
        self,
        *,
        room_ids: list[str],
        user_ids: list[int],
    ) -> None:
        if self._redis is None or (not room_ids and not user_ids):
            return

        async def operation(redis_client: Any) -> bool:
            keys = [_room_key(room_id) for room_id in room_ids]
            keys.extend(_room_user_key(user_id) for user_id in user_ids)
            if keys:
                await redis_client.delete(*keys)
            return True

        await self._redis_call("delete_rooms", operation)

    async def _flush_redis_state(
        self,
        *,
        room_ids_to_persist: list[str] | None = None,
        persist_queue: bool = True,
    ) -> None:
        if self._redis is None:
            return

        requested_room_ids = set(room_ids_to_persist or [])
        async with self._state_lock:
            deleted_room_ids = sorted(self._redis_deleted_room_ids)
            deleted_user_ids = sorted(self._redis_deleted_room_user_ids)
            self._redis_deleted_room_ids.clear()
            self._redis_deleted_room_user_ids.clear()
            queue_entries = [*self._judge_queue, *self._contestant_queue] if persist_queue else []
            rooms = [
                self._rooms_by_id[room_id]
                for room_id in sorted(requested_room_ids)
                if room_id in self._rooms_by_id
            ]

        await self._delete_rooms_from_redis(
            room_ids=deleted_room_ids,
            user_ids=deleted_user_ids,
        )
        await self._persist_room_snapshots_to_redis(rooms)
        if persist_queue:
            await self._persist_queue_entries_to_redis(queue_entries)

    async def _load_room_from_redis(self, room_id: str) -> LiveRoom | None:
        normalized_room_id = str(room_id or "").strip()
        if not normalized_room_id:
            return None

        async def operation(redis_client: Any) -> LiveRoom | None:
            raw_room = await redis_client.get(_room_key(normalized_room_id))
            if not raw_room:
                return None
            try:
                loaded = json.loads(str(raw_room))
            except Exception:
                return None
            return _room_from_dict(loaded)

        return await self._redis_call("load_room", operation)

    async def _lookup_room_id_for_user_from_redis(self, user_id: int) -> str | None:
        async def operation(redis_client: Any) -> str | None:
            room_id = await redis_client.get(_room_user_key(user_id))
            if not room_id:
                return None
            return str(room_id)

        return await self._redis_call("lookup_user_room", operation)

    async def _restore_room_for_user_from_redis(
        self,
        *,
        user_id: int,
        requested_room_id: object | None = None,
    ) -> str | None:
        if self._redis is None:
            return None

        room_id = str(requested_room_id or "").strip()
        if not room_id:
            room_id = await self._lookup_room_id_for_user_from_redis(user_id) or ""
        if not room_id:
            return None

        room = await self._load_room_from_redis(room_id)
        if room is None or user_id not in room.participant_ids:
            return None

        async with self._state_lock:
            existing_room_id = self._room_by_user_id.get(user_id)
            if existing_room_id is not None:
                return existing_room_id

            existing_room = self._rooms_by_id.get(room.room_id)
            if existing_room is None:
                self._rooms_by_id[room.room_id] = room
                existing_room = room

            for participant_id in existing_room.participant_ids:
                self._remove_from_queue_locked(participant_id)
                self._room_by_user_id[participant_id] = existing_room.room_id

        await self._persist_rooms_by_ids([room.room_id])
        await self._persist_queue_to_redis()
        return room.room_id

    def _remove_from_queue_locked(self, user_id: int) -> bool:
        entry = self._queue_by_user_id.pop(user_id, None)
        if entry is None:
            return False

        if entry.role == "judge":
            self._judge_queue = [queued for queued in self._judge_queue if queued.user_id != user_id]
        else:
            self._contestant_queue = [
                queued for queued in self._contestant_queue if queued.user_id != user_id
            ]
        return True

    def _consume_ready_rooms_locked(self) -> tuple[list[tuple[int, dict[str, object]]], list[str]]:
        notifications: list[tuple[int, dict[str, object]]] = []
        room_ids_to_start: list[str] = []
        while True:
            picked = self._pick_room_members_locked()
            if picked is None:
                break

            judge_entry, contestant_entries = picked
            room_id = uuid4().hex
            room = LiveRoom(
                room_id=room_id,
                judge_entry=judge_entry,
                contestant_entries=tuple(contestant_entries),  # type: ignore[arg-type]
                created_at=datetime.now(UTC),
            )
            self._rooms_by_id[room_id] = room
            for participant_id in room.participant_ids:
                self._room_by_user_id[participant_id] = room_id

            room_ids_to_start.append(room_id)
            notifications.append(
                (
                    judge_entry.user_id,
                    {
                        "type": "match_found",
                        "action": "match_found",
                        "room_id": room_id,
                        "roomId": room_id,
                        "role": "judge",
                        "participants": list(room.participant_ids),
                        "participant_ids": list(room.participant_ids),
                        "judge_id": judge_entry.user_id,
                        "judgeId": judge_entry.user_id,
                    },
                )
            )
            for contestant in contestant_entries:
                notifications.append(
                    (
                        contestant.user_id,
                        {
                            "type": "match_found",
                            "action": "match_found",
                            "room_id": room_id,
                            "roomId": room_id,
                            "role": "contestant",
                            "participants": list(room.participant_ids),
                            "participant_ids": list(room.participant_ids),
                            "judge_id": judge_entry.user_id,
                            "judgeId": judge_entry.user_id,
                        },
                    )
                )

        return notifications, room_ids_to_start

    def _pick_room_members_locked(self) -> tuple[LiveQueueEntry, list[LiveQueueEntry]] | None:
        if not self._judge_queue or len(self._contestant_queue) < 3:
            return None

        for judge_entry in self._judge_queue:
            compatible_contestants = [
                contestant
                for contestant in self._contestant_queue
                if contestant.country_code == judge_entry.country_code
                and self._is_compatible_pair(judge_entry, contestant)
            ]
            if len(compatible_contestants) < 3:
                continue

            picked_contestants = compatible_contestants[:3]
            self._judge_queue = [entry for entry in self._judge_queue if entry.user_id != judge_entry.user_id]
            picked_ids = {entry.user_id for entry in picked_contestants}
            self._contestant_queue = [
                entry for entry in self._contestant_queue if entry.user_id not in picked_ids
            ]
            self._queue_by_user_id.pop(judge_entry.user_id, None)
            for picked in picked_contestants:
                self._queue_by_user_id.pop(picked.user_id, None)
            return judge_entry, picked_contestants

        now = datetime.now(UTC)
        for judge_entry in sorted(self._judge_queue, key=lambda entry: entry.enqueued_at):
            compatible_contestants = sorted(
                (
                    contestant
                    for contestant in self._contestant_queue
                    if self._is_compatible_pair(judge_entry, contestant)
                ),
                key=lambda entry: entry.enqueued_at,
            )
            if len(compatible_contestants) < 3:
                continue

            picked_contestants = compatible_contestants[:3]
            oldest_entry = min(
                (judge_entry, *picked_contestants),
                key=lambda entry: entry.enqueued_at,
            )
            if now - oldest_entry.enqueued_at < timedelta(seconds=COUNTRY_FALLBACK_WAIT_SECONDS):
                continue

            self._judge_queue = [entry for entry in self._judge_queue if entry.user_id != judge_entry.user_id]
            picked_ids = {entry.user_id for entry in picked_contestants}
            self._contestant_queue = [
                entry for entry in self._contestant_queue if entry.user_id not in picked_ids
            ]
            self._queue_by_user_id.pop(judge_entry.user_id, None)
            for picked in picked_contestants:
                self._queue_by_user_id.pop(picked.user_id, None)
            return judge_entry, picked_contestants

        return None

    def _next_fallback_delay_locked(self) -> float | None:
        if not self._judge_queue or len(self._contestant_queue) < 3:
            return None

        now = datetime.now(UTC)
        next_ready_at: datetime | None = None
        for judge_entry in sorted(self._judge_queue, key=lambda entry: entry.enqueued_at):
            compatible_contestants = sorted(
                (
                    contestant
                    for contestant in self._contestant_queue
                    if self._is_compatible_pair(judge_entry, contestant)
                ),
                key=lambda entry: entry.enqueued_at,
            )
            if len(compatible_contestants) < 3:
                continue

            picked_contestants = compatible_contestants[:3]
            oldest_entry = min(
                (judge_entry, *picked_contestants),
                key=lambda entry: entry.enqueued_at,
            )
            ready_at = oldest_entry.enqueued_at + timedelta(seconds=COUNTRY_FALLBACK_WAIT_SECONDS)
            if next_ready_at is None or ready_at < next_ready_at:
                next_ready_at = ready_at

        if next_ready_at is None:
            return None
        return max(0.0, (next_ready_at - now).total_seconds())

    def _schedule_fallback_match_locked(self) -> None:
        delay = self._next_fallback_delay_locked()
        current_task = asyncio.current_task()
        existing_task = self._fallback_match_task

        if existing_task is not None and existing_task is not current_task and not existing_task.done():
            existing_task.cancel()

        if delay is None:
            if existing_task is not current_task:
                self._fallback_match_task = None
            return

        self._fallback_match_task = asyncio.create_task(
            self._run_fallback_matchmaking_timer(delay),
            name="live-country-fallback-matchmaking",
        )

    async def _run_fallback_matchmaking_timer(self, delay_seconds: float) -> None:
        try:
            if delay_seconds > 0:
                await asyncio.sleep(delay_seconds)

            notifications: list[tuple[int, dict[str, object]]] = []
            room_ids_to_start: list[str] = []
            async with self._state_lock:
                current_task = asyncio.current_task()
                if self._fallback_match_task is current_task:
                    self._fallback_match_task = None

                await self._refresh_queue_from_redis_locked()
                match_notifications, matched_room_ids = self._consume_ready_rooms_locked()
                notifications.extend(match_notifications)
                room_ids_to_start.extend(matched_room_ids)
                self._schedule_fallback_match_locked()

            await self._flush_redis_state(room_ids_to_persist=room_ids_to_start)
            await self._fanout_notifications(notifications)
            await self._start_room_loops(room_ids_to_start)
        except asyncio.CancelledError:
            return

    def _is_compatible_pair(self, judge_entry: LiveQueueEntry, contestant_entry: LiveQueueEntry) -> bool:
        judge_accepts = _preference_allows(judge_entry.preferred_gender, contestant_entry.gender)
        contestant_accepts = _preference_allows(
            contestant_entry.preferred_gender,
            judge_entry.gender,
        )
        return judge_accepts and contestant_accepts
