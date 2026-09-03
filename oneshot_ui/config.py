"""Runtime configuration for the PostgreSQL-backed localhost application."""

from dataclasses import dataclass, field
from pathlib import Path
import os


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _default_static_dir() -> str:
    return str(_repo_root())


def _load_dotenv(path: Path) -> None:
    """Load a simple KEY=VALUE file without adding a dotenv dependency.

    Supports two things a hand-written ``.env`` reliably contains: a leading
    ``export`` and quoted values (mandatory for a secret holding ``#`` or spaces).

    ``setdefault`` means a real environment variable always wins, so a
    deployment that injects its own config is never overridden by a stray file.
    """
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


def load_dotenv_files() -> None:
    """Pick up the repo-root ``.env`` for local development.

    Production passes real environment variables and ships no ``.env``, so this
    is a no-op there. Called from ``load_settings()`` rather than at import time
    so that constructing ``Settings`` directly — which every test does — never
    depends on whatever happens to be on this developer's disk.
    """
    for candidate in (Path.cwd() / ".env", _repo_root() / ".env"):
        _load_dotenv(candidate)


def _emails(raw: str) -> frozenset[str]:
    # Comma-separated allowlist. Sign-in is invite-only: an address absent from
    # this set is refused at the OAuth callback, so an empty value locks everyone
    # out rather than letting anyone in.
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


def _flag(raw: str, *, default: bool) -> bool:
    if not raw:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    dsn: str
    host: str = "127.0.0.1"
    port: int = 8766
    static_dir: str = field(default_factory=_default_static_dir)

    # Google sign-in. Empty values are allowed so tests can build an app without
    # credentials; /api/auth/login reports the misconfiguration instead.
    google_client_id: str = ""
    google_client_secret: str = ""
    session_secret: str = ""
    allowed_emails: frozenset[str] = frozenset()
    # Origin this server is reached at, used to build the OAuth redirect_uri. It
    # must match a URI registered in the Google console byte for byte.
    public_url: str = "http://127.0.0.1:8766"
    cookie_secure: bool = False


def load_settings() -> Settings:
    load_dotenv_files()
    return Settings(
        dsn=os.environ.get("DATABASE_URL", ""),
        host=os.environ.get("ONESHOT_HOST", "127.0.0.1"),
        port=int(os.environ.get("ONESHOT_PORT", "8766")),
        static_dir=os.environ.get("ONESHOT_STATIC_DIR") or _default_static_dir(),
        google_client_id=os.environ.get("ONESHOT_GOOGLE_CLIENT_ID", ""),
        google_client_secret=os.environ.get("ONESHOT_GOOGLE_CLIENT_SECRET", ""),
        session_secret=os.environ.get("ONESHOT_SESSION_SECRET", ""),
        allowed_emails=_emails(os.environ.get("ONESHOT_ALLOWED_EMAILS", "")),
        public_url=(
            os.environ.get("ONESHOT_PUBLIC_URL", "").rstrip("/")
            or "http://127.0.0.1:8766"
        ),
        cookie_secure=_flag(
            os.environ.get("ONESHOT_COOKIE_SECURE", ""), default=False
        ),
    )
