FROM python:3.12-slim

# clang is required by tinygrad's CPU JIT backend (brainchop/MindGrab uses tinygrad).
# tinygrad uses --target=arm64-none-unknown-elf which is Clang-specific syntax;
# gcc does not support this flag, so clang is required (not just CC=gcc).
RUN apt-get update && apt-get install -y --no-install-recommends clang && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml .
# Install all dependencies first (cached layer — only invalidated when deps change).
RUN uv pip install --system --no-cache ".[dev]"

# brainchop: native aarch64 skull-stripping via tinygrad (no Docker, no FSL).
# Runs as a subprocess inside this container via NativeExecutor.
RUN pip install --no-cache-dir brainchop==0.2.5

COPY . .
# Re-install the local package itself (non-editable) so console scripts can
# resolve `app.*` imports without /app in sys.path.  Deps are already cached
# above; --no-deps keeps this step fast.
RUN uv pip install --system --no-cache --no-deps .

# Run migrations then start the server
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
