from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import httpx
from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)

APP_VERSION = (
    os.environ.get("RENDER_GIT_COMMIT")
    or os.environ.get("GIT_COMMIT_SHA")
    or os.environ.get("VERCEL_GIT_COMMIT_SHA")
    or "development"
)

from app.api.routes.auth import router as auth_router
from app.api.routes.leaderboard import router as leaderboard_router
from app.api.routes.location import router as location_router
from app.api.routes.rounds import router as rounds_router
from app.api.routes.votes import router as votes_router
from app.core.auth import UserNotFoundForTokenError
from app.core.config import settings
from app.core.database import AsyncSessionLocal, init_db
from app.services.bot_simulation import ENABLE_API_BOTS, BotSimulationService
from app.services.countries_sync import ensure_countries_seeded
from app.services.live_manager import LiveConnectionManager, SIGNALING_TYPES


def _create_supabase_client() -> tuple[Client | None, httpx.Client | None]:
    url = (settings.supabase_url or "").strip()
    key = (settings.supabase_key or "").strip()
    if not url or not key:
        return None, None

    http_client = httpx.Client(
        timeout=httpx.Timeout(30.0),
        limits=httpx.Limits(
            max_connections=100,
            max_keepalive_connections=40,
            keepalive_expiry=45.0,
        ),
    )
    options = SyncClientOptions(
        auto_refresh_token=False,
        persist_session=False,
        httpx_client=http_client,
        postgrest_client_timeout=30,
        storage_client_timeout=30,
        function_client_timeout=30,
    )
    return create_client(url, key, options=options), http_client


def _close_supabase_client(
    *,
    supabase_client: Client | None,
    http_client: httpx.Client | None,
) -> None:
    if supabase_client is not None:
        auth_client = getattr(supabase_client, "auth", None)
        if auth_client is not None and hasattr(auth_client, "close"):
            try:
                auth_client.close()
            except Exception:
                pass

        for component_name in ("postgrest", "storage"):
            component = getattr(supabase_client, component_name, None)
            session = getattr(component, "session", None)
            if session is not None and hasattr(session, "close"):
                try:
                    session.close()
                except Exception:
                    pass

    if http_client is not None and not http_client.is_closed:
        try:
            http_client.close()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    supabase_client, supabase_http_client = _create_supabase_client()
    app.state.supabase = supabase_client
    app.state.supabase_http_client = supabase_http_client
    await init_db()
    async with AsyncSessionLocal() as session:
        await ensure_countries_seeded(session=session)
    if ENABLE_API_BOTS:
        async with AsyncSessionLocal() as session:
            bot_service = BotSimulationService(session)
            await bot_service.ensure_bots_seeded()
    try:
        yield
    finally:
        await live_connection_manager.close()
        _close_supabase_client(
            supabase_client=supabase_client,
            http_client=supabase_http_client,
        )


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
)
live_connection_manager = LiveConnectionManager()

uploads_dir = os.path.join(BACKEND_DIR, "uploads")
os.makedirs(uploads_dir, exist_ok=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://kissmerrykil.com",
        "https://www.kissmerrykil.com",
        "https://kiss-merry-kill.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)

app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

app.include_router(auth_router)
app.include_router(leaderboard_router)
app.include_router(location_router)
app.include_router(rounds_router)
app.include_router(votes_router)

# Backward-compatible aliases for deployments/frontends that call API endpoints with `/api` prefix.
app.include_router(leaderboard_router, prefix="/api", include_in_schema=False)
app.include_router(location_router, prefix="/api", include_in_schema=False)
app.include_router(rounds_router, prefix="/api", include_in_schema=False)
app.include_router(votes_router, prefix="/api", include_in_schema=False)


@app.exception_handler(UserNotFoundForTokenError)
async def user_not_found_for_token_handler(_: Request, __: UserNotFoundForTokenError) -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={
            "detail": "user_not_found",
            "error": "User not found for this token",
        },
    )


@app.get("/health", tags=["health"])
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/version", tags=["health"])
async def version_check() -> dict[str, str]:
    return {"status": "ok", "version": APP_VERSION}


@app.get("/")
def read_root() -> dict[str, str]:
    return {"status": "ok", "poruka": "Koren radi"}


@app.get("/api")
def read_api_root() -> dict[str, str]:
    return {"status": "ok", "poruka": "API koren radi"}


@app.websocket("/ws/live/{user_id}")
async def live_mode_socket(websocket: WebSocket, user_id: int) -> None:
    await live_connection_manager.connect(user_id, websocket)
    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except WebSocketDisconnect:
                raise
            except Exception:
                await websocket.send_json(
                    {
                        "type": "error",
                        "detail": "invalid_json_payload",
                    }
                )
                continue

            if not isinstance(payload, dict):
                await websocket.send_json(
                    {
                        "type": "error",
                        "detail": "payload_must_be_object",
                    }
                )
                continue

            action = str(payload.get("type") or payload.get("action") or "").strip().lower()
            if action in {"join_queue", "join", "find_match", "start_matchmaking", "start_queue"}:
                await live_connection_manager.join_queue(
                    user_id=user_id,
                    role=str(payload.get("role") or ""),
                    gender=payload.get("gender", payload.get("pol")),
                    preferred_gender=payload.get("preferred_gender", payload.get("preferredGender")),
                    country_code=payload.get(
                        "country_code",
                        payload.get("country", payload.get("countryCode")),
                    ),
                )
                continue

            if action in {"leave_queue", "leave", "cancel_queue", "leave_live"}:
                await live_connection_manager.leave_queue(user_id=user_id)
                continue

            if action in {"resume_room", "resume", "room_state"}:
                await live_connection_manager.resume_room(
                    user_id=user_id,
                    room_id=payload.get("room_id", payload.get("roomId")),
                )
                continue

            if action in SIGNALING_TYPES or action in {"icecandidate", "ice-candidate"}:
                if action in {"icecandidate", "ice-candidate"}:
                    payload["type"] = "ice_candidate"
                await live_connection_manager.relay_signaling_message(
                    from_user_id=user_id,
                    payload=payload,
                )
                continue

            if action in {"kill", "judge_kill", "judgekill", "judge_eliminate", "judgeeliminate", "eliminate"}:
                await live_connection_manager.submit_judge_kill_action(
                    judge_user_id=user_id,
                    payload=payload,
                )
                continue

            if action in {"judgment_complete", "judgmentcomplete", "judge_complete", "judgecomplete", "judge_done", "judgedone"}:
                await live_connection_manager.mark_judgment_complete(
                    judge_user_id=user_id,
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
    except Exception as exc:
        try:
            await websocket.send_json(
                {
                    "type": "error",
                    "detail": "websocket_runtime_error",
                    "message": str(exc),
                }
            )
        except Exception:
            pass
    finally:
        await live_connection_manager.disconnect(user_id, websocket=websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
