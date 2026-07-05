"""Simple single-operator API key auth for the dashboard/API.

Terra Trade runs on one operator's local machine (Docker Desktop) -- there is no
multi-tenant user system. A single static API key, supplied via the
`X-API-Key` header, gates every /api route and the /ws/live websocket.
"""
from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, WebSocket, status

from app.core.config import get_settings


async def require_api_key(x_api_key: str = Header(default="")) -> None:
    settings = get_settings()
    if not secrets.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing API key")


async def require_api_key_ws(websocket: WebSocket) -> bool:
    settings = get_settings()
    key = websocket.query_params.get("api_key", "")
    if not secrets.compare_digest(key, settings.api_key):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return False
    return True
