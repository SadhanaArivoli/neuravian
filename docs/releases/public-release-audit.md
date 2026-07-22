# Public release preparation audit

Date: 2026-07-21

## Verdict

**The repository content is substantially improved, but the public release is
not ready to publish today.** File-level presentation is no longer the primary
blocker. Distribution and GitHub repository settings are.

## Sixty-second first impression

After the README rewrite, a neuroscience graduate student can determine within
one minute:

- Neuravian is a unified, local-first workspace around trusted neuroimaging
  software—not a replacement scientific toolkit.
- Its central value is provenance, lineage, artifacts, visualization,
  reproducible execution, reports, and methods drafts.
- MRIQC is the only integration with documented local execution qualification,
  and that qualification has limitations.
- fMRIPrep is integrated but execution qualification is pending.
- FreeSurfer `recon-all`, QSIPrep, standalone ANTs, MRtrix3, and AFNI are not
  implemented pipelines.
- Current installation still requires a source checkout and Docker because no
  signed public installer is available.

That last point prevents a mature, download-first public experience.

## README redesign

The new README is structured as:

1. Product identity and one-paragraph explanation.
2. Early Access and research-use boundary.
3. Why Neuravian: workspace, provenance, methods, artifacts, visualization,
   reproducibility, architecture, desktop, and open source.
4. Download and platform availability.
5. Researcher quick start.
6. Conservative pipeline status summary linked to one canonical table.
7. Differentiation from upstream scientific tools.
8. Recorded provenance model.
9. Privacy and deployment model.
10. Screenshot gallery.
11. Developer installation.
12. Documentation, citation, and license.

## Documentation changes

- Replaced the old feature-heavy README with the researcher-first structure
  above.
- Added `docs/pipeline-status.md` as the only canonical public pipeline and
  qualification table.
- Rewrote `docs/installation.md` around platform/package availability before
  source-build instructions.
- Updated `docs/quickstart.md` to point to package availability and the canonical
  qualification table.
- Added pipeline status and known limitations to the documentation index.
- Replaced the old alpha release note with a superseded-document notice so old
  links remain valid without exposing obsolete claims.
- Updated architecture version language from alpha to the 0.1.0 Early Access
  release candidate.
- Marked the original desktop-launcher architecture as a historical design
  record rather than a current product status source.
- Corrected the fMRIPrep Apple Silicon FAQ and first-analysis tutorial.
- Rewrote the changelog around actual platform capabilities and bounded
  qualification.
- Updated `CITATION.cff`, `SECURITY.md`, and `CONTRIBUTING.md` to current release
  terminology and architecture.
- Added a screenshot inventory separating public candidates from historical QA
  evidence.
- Added an issue-template configuration with private security reporting and a
  troubleshooting route.

## Inaccurate or exaggerated claims corrected

| Previous claim or implication | Correction |
|---|---|
| Neuravian 0.1.0-alpha was an already published initial release | 0.1.0 is a pending Early Access public release; GitHub currently has no releases |
| Desktop installation was generally available | Only an unsigned, unnotarized macOS Apple Silicon bundle is produced locally |
| Windows, macOS, and Linux users could be given generic download instructions | Platform availability is explicit; Windows and Linux desktop packages do not exist |
| FreeSurfer was presented alongside implemented tools without enough distinction | `recon-all` is explicitly planned/not implemented; only compatible viewing and FastSurfer-related outputs exist |
| fMRIPrep was presented as runnable with only a local-unsafe warning | Integration is complete; scientific execution qualification is pending |
| Apple Silicon fMRIPrep behavior was described as producing bad results | The evidence only shows that qualification did not complete under emulation |
| Remote execution was described as future/not implemented in older documents | Researcher-managed workspaces and handoff exist, while universal cloud qualification does not |
| Methods and reports were described as publication-ready | User-facing copy now calls them provenance-based drafts requiring researcher review |
| Source data never leaves the machine | Data remains local by default; explicit remote handoff can transfer data to researcher-managed infrastructure |
| A manifest or automated test implied qualification | The canonical table distinguishes Integrated from Qualified |
| README pipeline totals acted as a support claim | The table lists every manifest and evidence boundary instead of using a promotional total |

## Screenshot audit

Current candidates and historical images are classified in
[`docs/screenshots/README.md`](../screenshots/README.md).

Recommended before public launch:

1. Replace the hero with a clean 1600×900 packaged-desktop capture using a
   neutral public dataset and no private paths.
2. Replace the Artifact Explorer image after final terminology changes.
3. Capture a dedicated full provenance panel.
4. Capture MRIQC with both application controls and report content legible.
5. Create and upload a 1280×640 GitHub social preview.

No historical screenshot was deleted because it remains qualification evidence.

## GitHub experience audit

Read-only GitHub inspection returned:

| Setting | Current state | Required action |
|---|---|---|
| Visibility | **Private** | Make public only after secrets/data review and release approval |
| Repository description | **Empty** | Suggested: “Local-first workspace for reproducible neuroimaging pipelines, provenance, artifacts, visualization, and methods.” |
| Homepage | **Empty** | Optional until a documentation site exists |
| Topics | **None** | Suggested: `neuroimaging`, `bids`, `mri`, `fmri`, `reproducibility`, `provenance`, `research-software`, `electron`, `fastapi`, `react` |
| Discussions | **Disabled** | Enable before linking it as the user-support channel |
| Releases | **None** | Publish signed/checksummed assets or clearly label a source-only pre-release |
| Social preview | Not represented in repository files | Upload a reviewed 1280×640 image in repository settings |
| License detection | GitHub API reports “Other” despite a standard Apache-2.0 text | Recheck after the repository becomes public; do not change the license text merely to force detection |

LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, CITATION, SECURITY, CODEOWNERS, CI,
three issue templates, a pull-request template, and private vulnerability
reporting are present.

## Remaining limitations

- No signed, notarized, or published desktop installer.
- No Windows desktop package and no Windows CI qualification.
- No Linux desktop package; Linux uses Docker Compose.
- Docker remains a prerequisite for the desktop shell and container tools.
- MRIQC participant progress was corrected after the qualified run but not
  requalified with another full participant execution.
- fMRIPrep scientific execution qualification is pending.
- Real authenticated cloud MRIQC execution was not qualified.
- Researcher-managed cloud/SSH environments cannot be universally qualified by
  contract tests.
- The backend has no multi-user authentication and must not be exposed directly
  to an untrusted network.
- Viewer/compression chunks produce production-build size warnings.

## Would I star it?

**No—not today.** A repository that is private, has no description or topics,
and offers no public release asset cannot yet deliver the open-source first
impression promised by this sprint. The software and evidence are interesting
enough to earn a star after a careful public-data/secrets review, a credible
download or explicitly source-only pre-release, complete repository metadata,
and a polished hero image. Claiming “yes” before those steps would contradict
the conservative standard used elsewhere in this audit.
