"""Settings from the environment, plus a repo-root .env for local development."""

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    dsn: str
    jobs_dsn: str = ""
    host: str = "127.0.0.1"
    port: int = 8766
    static_dir: str = str(ROOT / "web")
    # Empty Google credentials are allowed; /api/auth/login then reports them missing.
    google_client_id: str = ""
    google_client_secret: str = ""
    session_secret: str = ""
    # Builds the OAuth redirect_uri, which must match the one registered with Google.
    public_url: str = "http://127.0.0.1:8766"
    cookie_secure: bool = False
    # Empty disables company administration; only a stored verified email can match.
    company_editor_email: str = ""


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _load_dotenv(path: Path) -> None:
    """KEY=VALUE lines with optional `export` and quotes. Real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        if key:
            os.environ.setdefault(key, _unquote(value))


def load_dotenv_files() -> None:
    for candidate in (Path.cwd() / ".env", ROOT / ".env"):
        _load_dotenv(candidate)


def _database_url(raw: str) -> str:
    """Drop channel_binding, which asyncpg rejects; TLS settings are kept."""
    value = _unquote(raw)
    if not value:
        return ""
    parsed = urlsplit(value)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    return urlunsplit(parsed._replace(query=urlencode([item for item in query if item[0] != "channel_binding"])))


def load_settings() -> Settings:
    load_dotenv_files()
    env = os.environ.get
    return Settings(
        dsn=_database_url(env("DATABASE_URL", "")),
        jobs_dsn=_database_url(env("JOBS_DATABASE_URL", "")),
        host=env("ONESHOT_HOST", Settings.host),
        port=int(env("ONESHOT_PORT", Settings.port)),
        static_dir=env("ONESHOT_STATIC_DIR") or Settings.static_dir,
        google_client_id=env("ONESHOT_GOOGLE_CLIENT_ID", ""),
        google_client_secret=env("ONESHOT_GOOGLE_CLIENT_SECRET", ""),
        session_secret=env("ONESHOT_SESSION_SECRET", ""),
        public_url=env("ONESHOT_PUBLIC_URL", "").rstrip("/") or Settings.public_url,
        cookie_secure=env("ONESHOT_COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes", "on"},
        company_editor_email=env("ONESHOT_COMPANY_EDITOR_EMAIL", "").strip().lower(),
    )
