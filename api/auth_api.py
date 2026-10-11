"""Compatibility imports for sign-in routes, now defined in api.auth."""

from .auth import callback, login, logout, me, router

__all__ = ["callback", "login", "logout", "me", "router"]
