from __future__ import annotations

import asyncio
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import WebSocket


LIVE_ROLES = {"judge", "contestant"}
SIGNALING_TYPES = {"offer", "answer", "ice_candidate"}

INTRO_DURATION_SECONDS = 15
BATTLE_DURATION_SECONDS = 90
JUDGMENT_DURATION_SECONDS = 15
HARD_CUTOFF_SECONDS = (
    INTRO_DURATION_SECONDS + BATTLE_DURATION_SECONDS + JUDGMENT_DURATION_SECONDS
)
COUNTRY_FALLBACK_WAIT_SECONDS = 8


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

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        previous_socket: WebSocket | None = None
        async with self._state_lock:
            previous_socket = self._active_connections.get(user_id)
            self._active_connections[user_id] = websocket

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

    async def disconnect(self, user_id: int) -> None:
        notifications: list[tuple[int, dict[str, object]]] = []
        room_ids_to_start: list[str] = []
        async with self._state_lock:
            self._active_connections.pop(user_id, None)
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
                                    "user_id": user_id,
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

        await self._fanout_notifications(notifications)
        await self._start_room_loops(room_ids_to_start)

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
                            "role": entry.role,
                            "gender": entry.gender,
                            "preferred_gender": entry.preferred_gender,
                            "country_code": entry.country_code,
                        },
                    )
                )

                match_notifications, matched_room_ids = self._consume_ready_rooms_locked()
                notifications.extend(match_notifications)
                room_ids_to_start.extend(matched_room_ids)
                self._schedule_fallback_match_locked()

        if immediate_error is not None:
            await self._send_to_user(user_id, immediate_error)
            return

        await self._fanout_notifications(notifications)
        await self._start_room_loops(room_ids_to_start)

    async def leave_queue(self, *, user_id: int) -> bool:
        removed = False
        async with self._state_lock:
            removed = self._remove_from_queue_locked(user_id)
            self._schedule_fallback_match_locked()

        await self._send_to_user(
            user_id,
            {
                "type": "queue_left",
                "removed": removed,
            },
        )
        return removed

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

        target_raw = payload.get("target_user_id")
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
                        "target_user_id": target_user_id,
                        "sdp": payload.get("sdp"),
                        "candidate": payload.get("candidate"),
                        "mid": payload.get("mid"),
                        "mline_index": payload.get("mline_index"),
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
            payload.get("round_complete", payload.get("is_final", payload.get("finalize"))),
            default=True,
        )

        target_raw = payload.get("target_user_id", payload.get("user_id"))
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
                    },
                )
            )
        await self._fanout_notifications(notifications)

    async def mark_judgment_complete(self, *, judge_user_id: int) -> None:
        error_payload: dict[str, object] | None = None
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
            room.phase_task = asyncio.create_task(
                self._run_room_game_loop(room_id),
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
            room.started_at = datetime.now(UTC)
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

            try:
                await asyncio.wait_for(
                    room.decision_event.wait(),
                    timeout=JUDGMENT_DURATION_SECONDS,
                )
                await self._broadcast_to_room(
                    room_id,
                    {
                        "type": "round_completed",
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
                return
            except asyncio.TimeoutError:
                await self._broadcast_to_room(
                    room_id,
                    {
                        "type": "force_skip",
                        "reason": "time_expired",
                        "hard_cutoff_seconds": HARD_CUTOFF_SECONDS,
                    },
                )
                notifications, room_ids_to_start = await self._close_room(
                    room_id=room_id,
                    reason="time_expired",
                    requeue_connected=True,
                )
                await self._fanout_notifications(notifications)
                await self._start_room_loops(room_ids_to_start)
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
            room.phase = phase
            participant_ids = room.participant_ids

        notifications = [
            (
                participant_id,
                {
                    "type": "phase_change",
                    "phase": phase,
                    "duration": duration,
                    "room_id": room_id,
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
            return self._close_room_locked(
                room_id=room_id,
                reason=reason,
                requeue_connected=requeue_connected,
                excluded_requeue_user_ids=excluded_requeue_user_ids,
            )

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
                        "room_id": room_id,
                        "role": "judge",
                        "participants": list(room.participant_ids),
                    },
                )
            )
            for contestant in contestant_entries:
                notifications.append(
                    (
                        contestant.user_id,
                        {
                            "type": "match_found",
                            "room_id": room_id,
                            "role": "contestant",
                            "participants": list(room.participant_ids),
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

                match_notifications, matched_room_ids = self._consume_ready_rooms_locked()
                notifications.extend(match_notifications)
                room_ids_to_start.extend(matched_room_ids)
                self._schedule_fallback_match_locked()

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
