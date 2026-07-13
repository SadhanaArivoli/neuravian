# Security Policy

## Supported Versions

NeuroForge is currently in alpha (v0.1.0-alpha). Only the `main` branch receives security fixes.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

NeuroForge processes MRI data that may be sensitive. If you discover a vulnerability — particularly anything that could expose participant data, allow path traversal, or enable code injection — please report it privately.

**How to report:**
1. Open a [GitHub Security Advisory](https://github.com/SadhanaArivoli/neuroforge/security/advisories/new) (private, visible only to maintainers).
2. Include a description of the vulnerability, steps to reproduce, and the potential impact.

We aim to acknowledge reports within 5 business days and provide a fix or mitigation within 30 days for confirmed vulnerabilities.

## Security Design Notes

- NeuroForge runs entirely locally by default. No data is uploaded or transmitted.
- The backend binds to `localhost` only inside Docker; it is not intended to be exposed to the public internet.
- Source dataset directories are mounted **read-only** inside the container. NeuroForge does not modify source data.
- No authentication or multi-user access control is implemented in the current version. NeuroForge is designed for single-researcher local use.
- If you are deploying NeuroForge on a shared machine or network, you are responsible for access controls at the OS/network level.

## Out of Scope

- Issues in third-party tools (FSL, FreeSurfer, fMRIPrep, MRIQC, Docker) — report those upstream.
- Features not yet implemented (remote execution, authentication) — these are tracked in the roadmap.
