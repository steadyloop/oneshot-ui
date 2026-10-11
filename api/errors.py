"""Turning store results and refusals into HTTP errors."""

from contextlib import contextmanager
from typing import Any, Iterator

from fastapi import HTTPException


def found(value: Any, detail: str) -> Any:
    """`value`, or a 404 when the store found nothing (None, or False from a delete)."""
    if value is None or value is False:
        raise HTTPException(status_code=404, detail=detail)
    return value


@contextmanager
def refused(status: int = 422) -> Iterator[None]:
    """Report a store's refusal, a ValueError naming the reason, as `status`."""
    try:
        yield
    except ValueError as exc:
        raise HTTPException(status_code=status, detail=str(exc)) from exc
