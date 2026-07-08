"""Minimal JSON-RPC 2.0 server over Content-Length framed streams.

The framing matches the LSP scheme the app's MessageDecoder expects: each message
is `Content-Length: N\\r\\n\\r\\n` followed by N bytes of UTF-8 JSON.

A handler may return the DEFERRED sentinel to signal that it will write its own
response later (from a worker thread). This keeps the read loop responsive while
a long reconstruction runs, so a `cancel` request can actually be received.
"""

from __future__ import annotations

import json
import threading
from typing import Any, BinaryIO, Callable

# Handlers receive the params and the request id (None for notifications).
Handler = Callable[[Any, Any], Any]

# Sentinel: the handler will call respond()/respond_error() itself.
DEFERRED = object()


class FramedStream:
    """Reads and writes Content-Length framed JSON. Writes are thread-safe."""

    def __init__(self, reader: BinaryIO, writer: BinaryIO) -> None:
        self._reader = reader
        self._writer = writer
        self._write_lock = threading.Lock()

    def read_message(self) -> dict[str, Any] | None:
        length: int | None = None
        while True:
            line = self._reader.readline()
            if not line:
                return None  # end of stream
            stripped = line.strip()
            if stripped == b"":
                break
            if stripped.lower().startswith(b"content-length:"):
                length = int(stripped.split(b":", 1)[1].strip())
        if length is None:
            return None
        body = self._reader.read(length)
        return json.loads(body.decode("utf-8"))

    def write_message(self, message: dict[str, Any]) -> None:
        body = json.dumps(message).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        with self._write_lock:
            self._writer.write(header)
            self._writer.write(body)
            self._writer.flush()


class RpcServer:
    """Dispatches requests to registered handlers and streams notifications.

    Cancellation: a single reconstruction runs at a time. `register_cancel`
    stores an Event keyed by request id; `cancel_active` sets every stored Event
    so an in-flight job's should_cancel poll observes it.
    """

    DEFERRED = DEFERRED

    def __init__(self, stream: FramedStream) -> None:
        self._stream = stream
        self._handlers: dict[str, Handler] = {}
        self._cancels: dict[Any, threading.Event] = {}
        self._cancels_lock = threading.Lock()

    def method(self, name: str) -> Callable[[Handler], Handler]:
        def register(handler: Handler) -> Handler:
            self._handlers[name] = handler
            return handler

        return register

    def notify(self, method: str, params: Any) -> None:
        self._stream.write_message({"jsonrpc": "2.0", "method": method, "params": params})

    def respond(self, request_id: Any, result: Any) -> None:
        self._stream.write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(self, request_id: Any, code: int, message: str) -> None:
        self._stream.write_message(
            {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
        )

    def register_cancel(self, request_id: Any) -> threading.Event:
        event = threading.Event()
        with self._cancels_lock:
            self._cancels[request_id] = event
        return event

    def clear_cancel(self, request_id: Any) -> None:
        with self._cancels_lock:
            self._cancels.pop(request_id, None)

    def cancel_active(self) -> int:
        with self._cancels_lock:
            for event in self._cancels.values():
                event.set()
            return len(self._cancels)

    def serve_forever(self) -> None:
        while True:
            message = self._stream.read_message()
            if message is None:
                return
            self._dispatch(message)

    def _dispatch(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        method = message.get("method")
        handler = self._handlers.get(method) if isinstance(method, str) else None

        if handler is None:
            if request_id is not None:
                self.respond_error(request_id, -32601, f"method not found: {method}")
            return

        try:
            result = handler(message.get("params"), request_id)
        except Exception as error:  # noqa: BLE001 - report every failure to the client
            if request_id is not None:
                self.respond_error(request_id, -32000, str(error))
            return

        if result is DEFERRED:
            return  # the handler owns the response
        if request_id is not None:
            self.respond(request_id, result)
