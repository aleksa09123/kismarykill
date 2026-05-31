from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app.core.auth import resolve_user_from_access_token
from app.core.database import AsyncSessionLocal
from app.models.enums import VoteType
from app.models.user import User
from app.services.voting import VotingService

router = APIRouter(tags=["blind-mode"])

COUNTRY_FALLBACK_SECONDS = 7
VIBE_CHECK_SECONDS = 25
BLIND_SIGNALING_TYPES = {"offer", "answer", "ice_candidate"}


@dataclass
class BlindConnection:
    user_id: int
    websocket: WebSocket
    country_code: str
    connected_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class BlindRoom:
    room_id: str
    user_ids: tuple[int, int]
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    reveal_at: datetime = field(default_factory=lambda: datetime.now(UTC) + timedelta(seconds=VIBE_CHECK_SECONDS))
    choices: dict[int, VoteType] = field(default_factory=dict)
    reveal_task: asyncio.Task[None] | None = None

    def peer_for(self, user_id: int) -> int | None:
        if user_id == self.user_ids[0]:
            return self.user_ids[1]
        if user_id == self.user_ids[1]:
            return self.user_ids[0]
        return None


def _normalize_country_code(value: str | None) -> str:
    normalized = (value or "").strip().upper()
    return normalized or "GL"


def _choice_from_payload(value: object) -> VoteType | None:
    normalized = str(value or "").strip().lower()
    if normalized == VoteType.kiss.value:
        return VoteType.kiss
    if normalized == VoteType.marry.value:
        return VoteType.marry
    if normalized == VoteType.kill.value:
        return VoteType.kill
    return None


async def _user_from_token(websocket: WebSocket, token: str | None) -> User | None:
    supabase_client = getattr(websocket.app.state, "supabase", None)
    async with AsyncSessionLocal() as session:
        try:
            return await resolve_user_from_access_token(
                token=token,
                session=session,
                supabase_client=supabase_client,
            )
        except Exception:
            await session.rollback()
            return None


class BlindModeConnectionManager:
    """In-memory Blind Mode matchmaker and signaling relay.

    This is intentionally process-local: it is fast and simple for one backend
    instance. A Redis-backed queue can replace these dictionaries if the service
    is horizontally scaled.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._connections: dict[int, BlindConnection] = {}
        self._country_queues: dict[str, deque[int]] = defaultdict(deque)
        self._global_queue: deque[int] = deque()
        self._rooms: dict[str, BlindRoom] = {}
        self._room_by_user_id: dict[int, str] = {}
        self._fallback_tasks: dict[int, asyncio.Task[None]] = {}

    async def close(self) -> None:
        async with self._lock:
            sockets = [connection.websocket for connection in self._connections.values()]
            fallback_tasks = list(self._fallback_tasks.values())
            reveal_tasks = [room.reveal_task for room in self._rooms.values() if room.reveal_task is not None]
            self._connections.clear()
            self._country_queues.clear()
            self._global_queue.clear()
            self._rooms.clear()
            self._room_by_user_id.clear()
            self._fallback_tasks.clear()

        for task in [*fallback_tasks, *reveal_tasks]:
            task.cancel()
        for socket in sockets:
            try:
                await socket.close()
            except Exception:
                pass

    async def connect(self, *, user: User, websocket: WebSocket, country_code: str) -> None:
        await websocket.accept()
        previous_socket: WebSocket | None = None
        normalized_country = _normalize_country_code(country_code or user.country_code)
        async with self._lock:
            previous = self._connections.get(user.id)
            if previous is not None and previous.websocket is not websocket:
                previous_socket = previous.websocket
            self._connections[user.id] = BlindConnection(
                user_id=user.id,
                websocket=websocket,
                country_code=normalized_country,
            )

        if previous_socket is not None:
            try:
                await previous_socket.close(code=status.WS_1000_NORMAL_CLOSURE)
            except Exception:
                pass

        await self._send(
            user.id,
            {
                "type": "connected",
                "user_id": user.id,
                "country_code": normalized_country,
            },
        )

    async def disconnect(self, *, user_id: int, websocket: WebSocket | None = None) -> None:
        room_to_close: BlindRoom | None = None
        async with self._lock:
            current = self._connections.get(user_id)
            if current is not None and (websocket is None or current.websocket is websocket):
                self._connections.pop(user_id, None)
            else:
                return

            self._remove_from_queues_locked(user_id)
            self._cancel_fallback_locked(user_id)
            room_to_close = self._pop_room_for_user_locked(user_id)

        if room_to_close is not None:
            await self._notify_room_closed(room_to_close, reason="peer_disconnected", requeue=False)

    async def join_queue(self, *, user_id: int, country_code: str | None = None) -> None:
        users_to_match: tuple[int, int] | None = None
        normalized_country = _normalize_country_code(country_code)

        async with self._lock:
            connection = self._connections.get(user_id)
            if connection is None:
                return

            normalized_country = _normalize_country_code(country_code or connection.country_code)
            connection.country_code = normalized_country
            self._remove_from_queues_locked(user_id)
            self._cancel_fallback_locked(user_id)
            self._pop_room_for_user_locked(user_id)

            country_queue = self._country_queues[normalized_country]
            peer_id = self._pop_available_from_queue_locked(country_queue, excluded_user_id=user_id)
            if peer_id is not None:
                users_to_match = (peer_id, user_id)
            else:
                country_queue.append(user_id)
                # Keep the user local first; the fallback task moves them into
                # the global queue if no same-country peer appears in time.
                self._fallback_tasks[user_id] = asyncio.create_task(
                    self._fallback_to_global_after_delay(user_id=user_id, country_code=normalized_country)
                )

        if users_to_match is not None:
            await self._create_room(users_to_match, source="country")
            return

        await self._send(
            user_id,
            {
                "type": "queue_joined",
                "country_code": normalized_country,
                "fallback_seconds": COUNTRY_FALLBACK_SECONDS,
            },
        )

    async def handle_choice(self, *, user_id: int, action: VoteType) -> None:
        room: BlindRoom | None = None
        peer_id: int | None = None
        async with self._lock:
            room_id = self._room_by_user_id.get(user_id)
            room = self._rooms.get(room_id or "")
            if room is not None:
                peer_id = room.peer_for(user_id)

        if room is None or peer_id is None:
            await self._send(user_id, {"type": "error", "detail": "not_in_blind_room"})
            return

        # Persist the one-click KMK action before broadcasting it as locked.
        try:
            await self._persist_choice(voter_id=user_id, target_id=peer_id, action=action)
        except Exception:
            await self._send(user_id, {"type": "error", "detail": "choice_save_failed"})
            return

        async with self._lock:
            fresh_room = self._rooms.get(room.room_id)
            if fresh_room is None:
                return
            fresh_room.choices[user_id] = action

        await self._send(
            user_id,
            {
                "type": "choice_locked",
                "room_id": room.room_id,
                "action": action.value,
            },
        )

    async def relay_signaling_message(self, *, from_user_id: int, payload: dict[str, object]) -> None:
        message_type = str(payload.get("type") or "").strip().lower()
        if message_type not in BLIND_SIGNALING_TYPES:
            await self._send(from_user_id, {"type": "error", "detail": "invalid_signal_type"})
            return

        # Only relay WebRTC messages to the caller's active room peer.
        target_user_id = self._target_user_id_from_payload(payload)
        async with self._lock:
            room_id = self._room_by_user_id.get(from_user_id)
            room = self._rooms.get(room_id or "")
            if room is None:
                target_user_id = None
            elif target_user_id is None:
                target_user_id = room.peer_for(from_user_id)
            elif room.peer_for(from_user_id) != target_user_id:
                target_user_id = None

        if target_user_id is None:
            await self._send(from_user_id, {"type": "error", "detail": "invalid_signal_target"})
            return

        forwarded = dict(payload)
        forwarded["type"] = message_type
        forwarded["from_user_id"] = from_user_id
        forwarded["peer_id"] = from_user_id
        await self._send(target_user_id, forwarded)

    async def next_match(self, *, user_id: int) -> None:
        room_to_close: BlindRoom | None = None
        user_ids_to_requeue: tuple[int, ...] = ()
        async with self._lock:
            room_to_close = self._pop_room_for_user_locked(user_id)
            if room_to_close is not None:
                user_ids_to_requeue = room_to_close.user_ids
            else:
                self._remove_from_queues_locked(user_id)
                self._cancel_fallback_locked(user_id)
                user_ids_to_requeue = (user_id,)

        if room_to_close is not None:
            await self._notify_room_closed(room_to_close, reason="next_match", requeue=True)

        for queued_user_id in user_ids_to_requeue:
            connection = self._connections.get(queued_user_id)
            if connection is not None:
                await self.join_queue(user_id=queued_user_id, country_code=connection.country_code)

    async def _fallback_to_global_after_delay(self, *, user_id: int, country_code: str) -> None:
        try:
            await asyncio.sleep(COUNTRY_FALLBACK_SECONDS)
            users_to_match: tuple[int, int] | None = None
            async with self._lock:
                if user_id not in self._connections or self._room_by_user_id.get(user_id):
                    return
                country_queue = self._country_queues[country_code]
                self._remove_from_deque(country_queue, user_id)
                self._fallback_tasks.pop(user_id, None)

                peer_id = self._pop_available_from_queue_locked(self._global_queue, excluded_user_id=user_id)
                if peer_id is not None:
                    users_to_match = (peer_id, user_id)
                elif user_id not in self._global_queue:
                    self._global_queue.append(user_id)

            if users_to_match is not None:
                await self._create_room(users_to_match, source="global")
                return

            await self._send(
                user_id,
                {
                    "type": "search_expanded",
                    "country_code": country_code,
                },
            )
        except asyncio.CancelledError:
            return

    async def _create_room(self, user_ids: tuple[int, int], source: str) -> None:
        room = BlindRoom(
            room_id=f"blind_{uuid4().hex}",
            user_ids=user_ids,
        )
        room.reveal_task = asyncio.create_task(self._reveal_room_after_delay(room.room_id))

        async with self._lock:
            for user_id in user_ids:
                self._remove_from_queues_locked(user_id)
                self._cancel_fallback_locked(user_id)
                self._room_by_user_id[user_id] = room.room_id
            self._rooms[room.room_id] = room

        for user_id in user_ids:
            peer_id = room.peer_for(user_id)
            if peer_id is None:
                continue
            await self._send(
                user_id,
                {
                    "type": "match_found",
                    "room_id": room.room_id,
                    "peer_id": peer_id,
                    "peer": {"id": peer_id},
                    "initiator": user_id == min(user_ids),
                    "source": source,
                    "vibe_check_seconds": VIBE_CHECK_SECONDS,
                    "reveal_at": room.reveal_at.isoformat(),
                },
            )

    async def _reveal_room_after_delay(self, room_id: str) -> None:
        try:
            await asyncio.sleep(VIBE_CHECK_SECONDS)
            async with self._lock:
                room = self._rooms.get(room_id)
                if room is None:
                    return
                payloads = []
                for user_id in room.user_ids:
                    peer_id = room.peer_for(user_id)
                    payloads.append(
                        (
                            user_id,
                            {
                                "type": "reveal",
                                "room_id": room.room_id,
                                "your_choice": room.choices.get(user_id).value if room.choices.get(user_id) else None,
                                "peer_choice": room.choices.get(peer_id).value if peer_id and room.choices.get(peer_id) else None,
                                "peer": {"id": peer_id},
                            },
                        )
                    )

            for user_id, payload in payloads:
                await self._send(user_id, payload)
        except asyncio.CancelledError:
            return

    async def _notify_room_closed(self, room: BlindRoom, *, reason: str, requeue: bool) -> None:
        if room.reveal_task is not None:
            room.reveal_task.cancel()
        for user_id in room.user_ids:
            await self._send(
                user_id,
                {
                    "type": "room_closed",
                    "room_id": room.room_id,
                    "reason": reason,
                    "requeue": requeue,
                },
            )

    async def _send(self, user_id: int, payload: dict[str, object]) -> bool:
        connection = self._connections.get(user_id)
        if connection is None:
            return False
        try:
            await connection.websocket.send_json(payload)
            return True
        except Exception:
            return False

    async def _persist_choice(self, *, voter_id: int, target_id: int, action: VoteType) -> None:
        async with AsyncSessionLocal() as session:
            service = VotingService(session)
            await service.submit_blind_vote(voter_id=voter_id, target_id=target_id, action=action)

    def _target_user_id_from_payload(self, payload: dict[str, object]) -> int | None:
        for key in ("target_user_id", "targetUserId", "peer_id", "peerId"):
            raw = payload.get(key)
            parsed = int(raw) if isinstance(raw, int) else None
            if parsed is not None:
                return parsed
            try:
                parsed = int(str(raw))
            except (TypeError, ValueError):
                parsed = None
            if parsed is not None and parsed > 0:
                return parsed
        return None

    def _pop_room_for_user_locked(self, user_id: int) -> BlindRoom | None:
        room_id = self._room_by_user_id.pop(user_id, None)
        if not room_id:
            return None
        room = self._rooms.pop(room_id, None)
        if room is None:
            return None
        for participant_id in room.user_ids:
            self._room_by_user_id.pop(participant_id, None)
        return room

    def _cancel_fallback_locked(self, user_id: int) -> None:
        task = self._fallback_tasks.pop(user_id, None)
        if task is not None:
            task.cancel()

    def _remove_from_queues_locked(self, user_id: int) -> None:
        for queue in self._country_queues.values():
            self._remove_from_deque(queue, user_id)
        self._remove_from_deque(self._global_queue, user_id)

    def _pop_available_from_queue_locked(self, queue: deque[int], *, excluded_user_id: int) -> int | None:
        while queue:
            candidate_id = queue.popleft()
            if candidate_id != excluded_user_id and candidate_id in self._connections:
                return candidate_id
        return None

    @staticmethod
    def _remove_from_deque(queue: deque[int], user_id: int) -> None:
        try:
            queue.remove(user_id)
        except ValueError:
            pass


blind_mode_connection_manager = BlindModeConnectionManager()


@router.websocket("/ws/blind-mode")
async def blind_mode_socket(websocket: WebSocket) -> None:
    country_code = _normalize_country_code(websocket.query_params.get("country"))
    user = await _user_from_token(websocket, websocket.query_params.get("token"))
    if user is None:
        await websocket.accept()
        await websocket.send_json({"type": "error", "detail": "invalid_or_expired_token"})
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await blind_mode_connection_manager.connect(
        user=user,
        websocket=websocket,
        country_code=country_code,
    )
    await blind_mode_connection_manager.join_queue(user_id=user.id, country_code=country_code)

    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except WebSocketDisconnect:
                raise
            except Exception:
                await websocket.send_json({"type": "error", "detail": "invalid_json_payload"})
                continue

            if not isinstance(payload, dict):
                await websocket.send_json({"type": "error", "detail": "payload_must_be_object"})
                continue

            action = str(payload.get("type") or payload.get("action") or "").strip().lower()
            if action in {"join_queue", "join", "find_match", "start_queue"}:
                await blind_mode_connection_manager.join_queue(
                    user_id=user.id,
                    country_code=str(payload.get("country") or payload.get("country_code") or country_code),
                )
                continue

            if action in {"choice", "lock_choice", "vote"}:
                choice = _choice_from_payload(payload.get("choice") or payload.get("action_value") or payload.get("vote"))
                if choice is None:
                    await websocket.send_json({"type": "error", "detail": "invalid_choice"})
                    continue
                await blind_mode_connection_manager.handle_choice(user_id=user.id, action=choice)
                continue

            if action in {"next_match", "disconnect_next", "leave_room"}:
                await blind_mode_connection_manager.next_match(user_id=user.id)
                continue

            if action in BLIND_SIGNALING_TYPES or action in {"icecandidate", "ice-candidate"}:
                if action in {"icecandidate", "ice-candidate"}:
                    payload["type"] = "ice_candidate"
                await blind_mode_connection_manager.relay_signaling_message(
                    from_user_id=user.id,
                    payload=payload,
                )
                continue

            if action == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            await websocket.send_json(
                {
                    "type": "error",
                    "detail": "unsupported_action",
                    "received_action": action,
                }
            )
    except WebSocketDisconnect:
        pass
    finally:
        await blind_mode_connection_manager.disconnect(user_id=user.id, websocket=websocket)
