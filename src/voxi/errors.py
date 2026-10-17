# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


class PlatformError(Exception):
    def __init__(self, status: int, message: str, code: str, param: str | None = None):
        self.status = status
        self.message = message
        self.code = code
        self.param = param
        super().__init__(message)


def error_response(status: int, message: str, code: str, param: str | None = None):
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "message": message,
                "type": "invalid_request_error" if status < 500 else "server_error",
                "param": param,
                "code": code,
            }
        },
        headers={"WWW-Authenticate": "Bearer"} if status == 401 else None,
    )


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(PlatformError)
    async def platform_error(request: Request, exc: PlatformError):
        return error_response(exc.status, exc.message, exc.code, exc.param)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Never echo input values, transcripts or credentials in error messages.
        first = exc.errors()[0]
        loc = ".".join(str(part) for part in first["loc"])
        return error_response(
            400, f"Invalid parameter {loc}: {first['msg']}", "invalid_parameter", loc
        )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return error_response(exc.status_code, str(exc.detail), "http_error")

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception):
        return error_response(500, "Internal service failure", "internal_error")
