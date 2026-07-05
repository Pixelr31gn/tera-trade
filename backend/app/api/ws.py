from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.ws_manager import manager
from app.core.security import require_api_key_ws

router = APIRouter()


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket) -> None:
    if not await require_api_key_ws(websocket):
        return
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # dashboard doesn't send anything meaningful; keeps the connection alive
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)
