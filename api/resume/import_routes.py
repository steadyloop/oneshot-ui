"""Stateless, bounded parsing for signed-in and browser-local profiles."""

from typing import Literal

import anyio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .parser import MAX_FILE_BYTES, ParseError, ParsedResume, parse_document, parse_text

router = APIRouter(prefix="/api/resume", tags=["resume"])


@router.post("/parse", response_model=ParsedResume)
async def parse_resume(request: Request, file_type: Literal["pdf", "docx", "text"]):
    try:
        length = request.headers.get("content-length")
        if length and int(length) > MAX_FILE_BYTES:
            raise ParseError("too_large", "Resume files must be 10 MB or smaller.")
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_FILE_BYTES:
                raise ParseError("too_large", "Resume files must be 10 MB or smaller.")
            data.extend(chunk)
        if file_type == "text":
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ParseError("invalid_text", "Paste UTF-8 resume text instead.") from exc
            return await anyio.to_thread.run_sync(parse_text, text)
        return await anyio.to_thread.run_sync(parse_document, bytes(data), file_type)
    except ParseError as exc:
        return JSONResponse(status_code=413 if exc.code == "too_large" else 422,
                            content={"error": {"code": exc.code, "message": str(exc)}})
    except ValueError:
        return JSONResponse(status_code=400, content={"error": {
            "code": "invalid_length", "message": "Invalid request length."}})
