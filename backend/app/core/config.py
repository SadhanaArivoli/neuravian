from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    app_name: str = "NeuroForge"
    database_url: str = "sqlite:///./neuroforge.db"
    # Allow frontend dev server and docker compose origins
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://frontend:3000",
    ]
    # The host path that is mounted at /host-data inside the container.
    # When set, the backend rewrites paths transparently so users can paste
    # their normal Mac paths into the import form.
    host_datasets_mount: str | None = None
    # Directory used for run logs and pipeline derivatives output.
    # In Docker this maps to the data volume (/app/data). In local dev it
    # defaults to ./data relative to the working directory.
    data_dir: str = "./data"


settings = Settings()
