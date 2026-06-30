# NeuroForge

A local-first orchestration platform for neuroimaging tools (MRIQC, fMRIPrep).
Wraps validated open-source tools behind a beginner-friendly UI — runs on your laptop,
never sends data anywhere, uses official Docker containers unchanged.

---

## Quick start

```bash
# 1. Copy and edit the environment file
cp .env.example .env
#    Open .env and set HOST_DATASETS_DIR to the folder where your datasets live
#    (see "Importing datasets" below)

# 2. Start the platform
docker compose up

# 3. Open the UI
open http://localhost:3000
```

The backend API is at `http://localhost:8000` and auto-documents itself at
`http://localhost:8000/docs`.

---

## Importing datasets that live outside the project folder

### How it works

Your BIDS datasets live somewhere on your Mac — typically `~/Documents` or a
dedicated folder. The backend runs inside Docker and can only see directories
that are explicitly mounted into the container. NeuroForge handles this
transparently: you type your normal Mac path into the import form, and the
backend translates it automatically.

### Setup (one time)

1. **Copy `.env.example` to `.env`** (already done if you followed Quick start):

   ```bash
   cp .env.example .env
   ```

2. **Set `HOST_DATASETS_DIR`** in `.env` to the directory that contains your
   datasets. It should be an ancestor of all the BIDS folders you want to import:

   ```bash
   # .env
   HOST_DATASETS_DIR=/Users/yourname/Documents
   ```

   If all your datasets are in a dedicated folder, use that instead:

   ```bash
   HOST_DATASETS_DIR=/Users/yourname/neuroforge-data
   ```

   The default if you leave it unset is `~/Documents`.

3. **Restart the stack** after editing `.env`:

   ```bash
   docker compose down && docker compose up
   ```

### Importing a dataset

In the UI go to **Datasets → Import dataset** and type the full Mac path to
your BIDS dataset folder:

```
/Users/yourname/Documents/bids-examples/ds001
```

You do not need to know anything about Docker or container paths — NeuroForge
rewrites the path internally. The dataset is opened **read-only**; your files
are never modified.

**The path must be inside `HOST_DATASETS_DIR`.** If you get a "Path does not
exist" error for a path you know is real, check that `HOST_DATASETS_DIR` covers
it and that you restarted the stack after changing `.env`.

### Example

```
HOST_DATASETS_DIR=/Users/alice/Documents

Import path typed in the UI:
  /Users/alice/Documents/studies/pilot-bids

→ resolves inside the container to:
  /host-data/studies/pilot-bids          (transparent, user never sees this)
```

---

## Development

### Backend (Python 3.12 + FastAPI)

```bash
cd backend
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install -e ".[dev]"
uvicorn app.main:app --reload   # http://localhost:8000
```

Run migrations:

```bash
alembic upgrade head
```

Run tests:

```bash
pytest
```

### Frontend (React + TypeScript + Vite + Tailwind)

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173  (proxies /api → localhost:8000)
```

Run tests:

```bash
npm test
```

---

## Architecture

See [`docs/architecture/neuroimaging-platform-architecture.md`](docs/architecture/neuroimaging-platform-architecture.md)
for the full design document including tech stack rationale, database schema,
pipeline manifest format, and the development roadmap.

---

## Project status

| Milestone | Status |
|---|---|
| M1 — Project skeleton (FastAPI + React + Docker Compose + CI) | ✅ Done |
| M2 — BIDS dataset import, validation, and browser | ✅ Done |
| M3 — Pipeline manifest schema & registry | 🔜 Next |
| M4 — Docker execution engine (MRIQC end-to-end) | Planned |
| M5+ — Provenance, error translation, results viewer, fMRIPrep | Planned |
