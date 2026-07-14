# NeuroForge desktop prototype

This directory contains a thin Electron launcher for the existing NeuroForge
Docker Compose deployment. It does not contain a replacement frontend, backend,
database, or scientific execution system.

## Prototype prerequisites

- macOS on Apple Silicon
- Docker Desktop with Docker Compose 2.24.4 or newer
- the NeuroForge source checkout and its existing `.env`
- Node.js/npm for development builds

## Asset generation

The original logo remains outside the repository and is never modified. Generate
the checked desktop derivatives with:

```bash
./scripts/generate-icons.sh /absolute/path/to/neuroforge-logo.001-removebg-preview.png
```

## Development commands

```bash
npm install
npm run typecheck
npm test
npm run dev
npm run dist:mac
```

`npm run dist:mac` produces the unsigned development bundle under
`desktop/dist/mac-arm64/NeuroForge.app`.

The canonical manual deployment remains:

```bash
docker compose up --build
```
