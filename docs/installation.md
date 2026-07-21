# Installation Guide

## Requirements

- macOS or Linux
- Docker Desktop or Docker Engine with Compose v2
- Git
- 8 GB RAM minimum; 16 GB or more recommended
- Enough disk space for container images and derivatives

Windows through WSL2 may work but is not part of the current CI matrix.

## Install

```bash
git clone https://github.com/SadhanaArivoli/neuroforge.git
cd neuroforge
cp .env.example .env
```

Set `HOST_DATASETS_DIR` in `.env` to the parent directory containing the
datasets you intend to import. NeuroForge mounts this directory read-only at
`/host-data` inside the backend container.

Start the application:

```bash
docker compose up --build
```

Open <http://localhost:3000>. A green **Backend connected** indicator confirms
that the frontend can reach the API.

## Desktop application

The macOS Electron shell uses the same Compose services and data. See
[desktop/README.md](../desktop/README.md) for desktop prerequisites and launch
commands. Do not run a second Compose project against the same ports.

## Update

Commit or preserve any local source changes, then update the repository and
rebuild:

```bash
git pull --ff-only
docker compose build
docker compose up -d --force-recreate
```

Database migrations run during backend startup. Confirm health with
`docker compose ps`; do not delete the database to resolve a migration error.

## Stop and back up

```bash
docker compose down
```

Back up `data/neuroforge.db`, `data/derivatives/`, and any workspace metadata
needed by your lab. `docker compose down` preserves these files. Never use
`docker compose down -v` unless you intentionally want to remove managed data.
