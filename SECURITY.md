# Security Policy

## Supported Versions

Neuravian 0.1.0 is in Early Access. Only the `main` branch receives security fixes.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Neuravian processes MRI data that may be sensitive. If you discover a vulnerability — particularly anything that could expose participant data, allow path traversal, or enable code injection — please report it privately.

**How to report:**
1. Open a [GitHub Security Advisory](https://github.com/SadhanaArivoli/neuravian/security/advisories/new) (private, visible only to maintainers).
2. Include a description of the vulnerability, steps to reproduce, and the potential impact.

We aim to acknowledge reports within 5 business days and provide a fix or mitigation within 30 days for confirmed vulnerabilities.

## Security Design Notes

- Neuravian runs locally by default. Data is transferred only when a researcher
  explicitly configures and confirms a remote workspace or execution handoff.
- The backend binds to `localhost` only inside Docker; it is not intended to be exposed to the public internet.
- Source dataset directories are mounted **read-only** inside the container. Neuravian does not modify source data.
- No authentication or multi-user access control is implemented in the current version. Neuravian is designed for single-researcher local use.
- If you are deploying Neuravian on a shared machine or network, you are responsible for access controls at the OS/network level.

## Out of Scope

- Issues in third-party tools (FSL, FreeSurfer, fMRIPrep, MRIQC, Docker) — report those upstream.
- Authentication for shared or public deployments is not implemented. Remote
  execution targets researcher-managed infrastructure and does not make the
  backend safe to expose publicly.
