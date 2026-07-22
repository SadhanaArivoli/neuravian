# Contributing to Neuravian

Thank you for your interest in contributing. Neuravian is an Early Access
open-source project and welcomes contributions from neuroimaging researchers,
software engineers, and students at all experience levels.

## Before You Start

Read [AGENTS.md](AGENTS.md) for the project philosophy, [README.md](README.md) for
the product overview, and [docs/architecture.md](docs/architecture.md) for the
current architecture. The most important constraint: Neuravian wraps and
connects existing neuroimaging tools—it does not reimplement their algorithms.

## Ways to Contribute

**Pipeline manifests** — the lowest barrier to entry. Adding a new pipeline means writing a YAML file in `pipelines/` and adding its entry point or Docker wrapper. See any existing `.yaml` for structure.

**Frontend features** — React + TypeScript, Vite. Components live in `frontend/src/components/` and pages in `frontend/src/pages/`. Typed throughout.

**Backend features** — FastAPI + SQLAlchemy + SQLite. API routes in `backend/app/api/`, services in `backend/app/services/`, native tool entry points in `backend/app/tools/`.

**Bug reports** — open an issue with steps to reproduce, your OS, Docker version, and the run log if applicable.

**Documentation** — corrections, clarifications, or additions to the README, architecture docs, or pipeline help text.

## Development Setup

```bash
git clone https://github.com/SadhanaArivoli/neuravian.git
cd neuravian

# Backend (Python 3.12, uv)
cd backend
uv sync --extra dev
uv run alembic upgrade head
uv run uvicorn app.main:app --reload   # http://localhost:8000

# Frontend (Node 20)
cd ../frontend
npm install
npm run dev   # http://localhost:5173
```

## Running Tests

```bash
# Backend (must be run from backend/)
cd backend
uv run pytest

# Frontend
cd frontend
npx tsc --noEmit   # type check
npm test            # Vitest
npm run build       # production build
```

GitHub Actions runs these on every push. Both must pass before a PR is merged.

## Adding a Pipeline

1. Create `pipelines/<id>.yaml` following the existing manifest schema (`pipelines/schema/manifest.schema.json`).
2. If the pipeline is native Python, add an entry point in `backend/app/tools/` and register it in `backend/app/services/pipeline.py`.
3. If Docker-based, define the `execution.type: docker` block in the manifest.
4. Add at least one test in `backend/tests/test_<id>.py`.
5. Update the frontend test mock in `frontend/tests/workflowTemplates.test.ts` if your pipeline's artifact types are used in workflow templates.
6. Update the canonical [`docs/pipeline-status.md`](docs/pipeline-status.md)
   table and link qualification evidence. Do not claim qualification from tests
   alone.

## Pull Request Guidelines

- **Keep PRs focused.** One feature, one fix, or one pipeline per PR.
- **Tests required.** Backend PRs need pytest coverage. Frontend PRs need Vitest coverage for any new pure logic.
- **No weakening tests.** Do not skip, comment out, or loosen assertions to make CI pass.
- **No AI-generated scientific content.** Methods prose must be template-filled from provenance records, not AI-generated inference.
- **No new external API dependencies** without discussion. The project runs fully offline by default.
- **No telemetry, analytics, or tracking code.**

## Commit Style

Use the imperative mood in the subject line (`Add`, `Fix`, `Remove`, not `Added` or `Fixes`). Include the scope when useful:

```
feat(pipeline): integrate an upstream BIDS App
fix(ci): install Playwright browser binary before running backend tests
docs: update pipeline table for ALFF and ReHo
```

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security Issues

See [SECURITY.md](SECURITY.md). Do not open a public issue for a security vulnerability.
