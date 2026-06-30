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


settings = Settings()
