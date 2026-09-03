import uvicorn

from oneshot_ui.config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(
        "oneshot_ui.app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
