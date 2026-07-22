# Neuravian branding migration

## Scope

The private, pre-release product name was migrated from **NeuroForge** to
**Neuravian** across application copy, Electron metadata, package metadata,
configuration, APIs, storage namespaces, container labels, infrastructure,
pipeline manifests, tests, documentation, and maintained assets.

Neuravian is described consistently as an open-source desktop workspace for
reproducible neuroimaging research. Public copy emphasizes provenance, lineage,
artifact management, methods drafts, visualization, and reproducibility. Claims
such as “publication-ready” were replaced with conservative language requiring
researcher review.

## Technical changes

- Electron uses `productName: Neuravian`, `appId: org.neuravian.desktop`, the
  Neuravian icon set, Neuravian window/menu/About text, and Neuravian package
  names.
- JavaScript and Python package names, Compose project/service metadata, API
  identity headers, environment-variable prefixes, local storage keys, database
  defaults, infrastructure names, scripts, and first-party container tags use
  the new name.
- First-party assets, FSL wrapper scripts, AWS templates/policies, the example
  plugin executable, and verification commands were renamed on disk.
- README, installation, support, security, contribution, citation, release,
  architecture, tutorial, qualification, and GitHub template content was
  migrated.
- Historical screenshots were retained. The complete review queue is in
  [screenshot-regeneration.md](screenshot-regeneration.md).

## Renamed maintained paths

The following old → new path pairs comprise the filesystem migration:

- `desktop/assets/NeuroForge.icns` → `desktop/assets/Neuravian.icns`
- `desktop/assets/NeuroForge.iconset/` → `desktop/assets/Neuravian.iconset/`
- `desktop/assets/neuroforge-logo.png` → `desktop/assets/neuravian-logo.png`
- `desktop/assets/neuroforge-splash.png` → `desktop/assets/neuravian-splash.png`
- `desktop/assets/neuroforge-window.png` → `desktop/assets/neuravian-window.png`
- `docker/fsl-bet/neuroforge-bet.sh` → `docker/fsl-bet/neuravian-bet.sh`
- `docker/fsl-fast/neuroforge-fast.sh` → `docker/fsl-fast/neuravian-fast.sh`
- `docker/fsl-flirt/neuroforge-flirt.sh` → `docker/fsl-flirt/neuravian-flirt.sh`
- `docker/fsl-fnirt/neuroforge-fnirt.sh` → `docker/fsl-fnirt/neuravian-fnirt.sh`
- `docs/reviews/neuroforge-multi-perspective-audit.md` →
  `docs/reviews/neuravian-multi-perspective-audit.md`
- `infra/aws/config/neuroforge-x86.env.example` →
  `infra/aws/config/neuravian-x86.env.example`
- `infra/aws/iam/neuroforge-deployer-trust-policy.json` →
  `infra/aws/iam/neuravian-deployer-trust-policy.json`
- `infra/aws/iam/neuroforge-instance-role-policy.json` →
  `infra/aws/iam/neuravian-instance-role-policy.json`
- `infra/aws/iam/neuroforge-instance-trust-policy.json` →
  `infra/aws/iam/neuravian-instance-trust-policy.json`
- `infra/aws/policies/neuroforge-deployer-policy.json` →
  `infra/aws/policies/neuravian-deployer-policy.json`
- `infra/aws/policies/neuroforge-optional-budget-policy.json` →
  `infra/aws/policies/neuravian-optional-budget-policy.json`
- `infra/aws/scripts/05-deploy-neuroforge.sh` →
  `infra/aws/scripts/05-deploy-neuravian.sh`
- `plugins/image-statistics/backend/neuroforge-image-statistics` →
  `plugins/image-statistics/backend/neuravian-image-statistics`
- `verification/x86/commands/01-neuroforge-health.sh` →
  `verification/x86/commands/01-neuravian-health.sh`

The iconset directory contains ten size-specific PNG files whose basenames were
already generic; moving the directory updates all ten paths together.

Direct references to these renamed paths were updated in:

- `backend/tests/test_pipelines.py`
- `backend/tests/test_plugin_loader.py`
- `desktop/electron-builder.yml`
- `desktop/scripts/copy-renderer.mjs`
- `desktop/scripts/generate-icons.sh`
- `desktop/src/main/index.ts`
- `desktop/src/renderer/index.html`
- `desktop/tests/assets.test.ts`
- `docker/fsl-bet/Dockerfile`
- `docker/fsl-fast/Dockerfile`
- `docker/fsl-flirt/Dockerfile`
- `docker/fsl-fnirt/Dockerfile`
- `docs/cloud/aws-automated-deployment-architecture.md`
- `docs/cloud/aws-launch-checklist.md`
- `docs/cloud/aws-x86-deployment-guide.md`
- `docs/cloud/x86-session-plan.md`
- `docs/desktop/prototype-verification.md`
- `infra/aws/README.md`
- `infra/aws/scripts/02-bootstrap-iam.sh`
- `infra/aws/scripts/05-deploy-neuravian.sh`
- `infra/aws/tests/test_preflight_plan.py`
- `infra/terraform/aws-ec2/README.md`
- `plugins/image-statistics/README.md`
- `plugins/image-statistics/backend/neuravian-image-statistics`
- `plugins/image-statistics/pipelines/image-statistics.yaml`

Indirect references—package names, environment variables, database defaults,
Compose/image names, installer metadata, storage keys, and generated artifact
names—were updated throughout the corresponding backend, frontend, desktop,
pipeline, infrastructure, verification, and documentation files in the main
branding diff. They are content identifiers rather than filesystem renames.

## Intentional remaining legacy-name occurrences

1. **Current private repository URL.** Links still target
   `github.com/SadhanaArivoli/neuroforge` because that is the existing repository
   address. They must be updated atomically after the repository is renamed; no
   future URL is asserted in source.
2. **Historical clarification.** `CHANGELOG.md` says “formerly NeuroForge” once
   so historical commits and qualification evidence remain understandable.
3. **Historical screenshots.** Two screenshot filenames contain the former
   name. They are evidence and are not deleted or rewritten.
4. **Local and generated state.** `.neuroforge-aws/`, existing
   `neuroforge.db` files, cached build output, evidence archives, and the
   untracked root `index.js` predate this migration. They are deliberately not
   rewritten: changing them could invalidate evidence or damage user state.

The complete remaining repository-path inventory at migration validation was:

- `.codex-artifacts/neuroforge-terraform-aws-ec2.zip` — ignored generated archive.
- `.neuroforge-aws/` — ignored pre-rename live AWS state; retained to prevent
  destructive or misleading cloud-resource migration.
- `neuroforge.db`, `backend/neuroforge.db`, and `data/neuroforge.db` — ignored
  local SQLite databases; the active default for new deployments is
  `data/neuravian.db`.
- `backend/neuroforge_backend.egg-info/` — ignored stale generated Python
  package metadata; a current `neuravian_backend.egg-info/` is generated by the
  renamed package.
- `infra/terraform/aws-ec2/neuroforge.tfplan` and
  `infra/terraform/aws-ec2/neuroforge-free.tfplan` — ignored binary Terraform
  plans whose contents must not be renamed or reused after configuration drift.
- `verification/x86/neuroforge-x86-evidence.zip` and the four
  `verification/x86/evidence/logs/01-neuroforge-health-*.log` files — ignored,
  immutable historical qualification evidence.
- `docs/screenshots/unified-multi-workspace/aws-neuroforge.png` and
  `docs/screenshots/unified-multi-workspace/local-neuroforge.png` — tracked,
  immutable historical screenshots, explicitly labeled historical where linked.
- The local checkout directory `/Users/arivolitirouvingadame/Documents/neuroforge`
  — external to repository contents; rename the checkout only after tools and
  shell sessions no longer depend on its absolute path.

The stale generated `desktop/build/renderer/neuroforge-splash.png` was removed
from the build output and the copy step now removes it idempotently. This was
necessary because `electron-builder` previously included it in `app.asar`.

## Runtime-data compatibility decision

New installations use Electron's canonical Neuravian `userData` directory and
the active Compose database is `data/neuravian.db`. If the canonical desktop
directory is empty and a populated `NeuroForge` or `neuroforge-desktop`
Application Support directory exists, startup temporarily selects that legacy
directory in place. It does not move, copy, merge, or delete anything. The
selection and both paths are written to the desktop startup log. Tests cover new
installs, legacy fallback, and canonical-data precedence.

This compatibility mode is intentional because workspace credentials may be
encrypted through Electron `safeStorage`; copying them across application
identities has not been qualified. Existing SQLite databases, AWS plans/state,
logs, caches, generated bundles, and evidence archives remain untouched. Old
logs remain historical; new logs use Electron's Neuravian identity.

Environment variables and API routes are safe to rename before the first public
release. No legacy environment-variable alias is promised. The Python and npm
distribution names, Docker images, Compose project, and bundle identifier use
Neuravian. Scientific module import paths and API route namespaces were not
brand-derived and therefore did not require renaming.

## Bundle identifier decision

The bundle identifier changed from `org.neuroforge.desktop` to
`org.neuravian.desktop`. This is appropriate before the first public release and
avoids shipping the former brand. macOS treats it as a separate application:
preferences, permissions, caches, login items, and keychain entries associated
with the former identifier do not migrate automatically. Before release, verify
that no signed build or managed deployment depends on the former identifier.

## GitHub cutover recommendations

- Rename the private repository to `neuravian` if that name is available.
- Suggested description: “Neuravian is an open-source desktop workspace for
  reproducible neuroimaging research, provenance, lineage, artifacts,
  visualization, and methods drafts.”
- Suggested topics: `neuroimaging`, `bids`, `reproducibility`, `provenance`,
  `electron`, `research-software`, `mri`, `open-source`.
- Set a homepage only when a real maintained URL exists.
- Regenerate the social preview from approved Neuravian artwork.
- After the rename, update repository links, badges, clone commands, deployment
  allowlists, generated methods URLs, and the repository URL in `CITATION.cff`.

### Exact post-cutover URL checklist

Immediately after GitHub confirms the repository rename, update and validate the
current repository URL in every one of these maintained files:

- `.github/ISSUE_TEMPLATE/config.yml`
- `CITATION.cff`
- `CONTRIBUTING.md`
- `README.md`
- `SECURITY.md`
- `backend/app/api/health.py`
- `desktop/tests/native-shell.test.ts`
- `docs/branding/migration-report.md`
- `docs/cloud/aws-x86-deployment-guide.md`
- `docs/installation.md`
- `docs/qa/mriqc-execution-qualification/generated-methods-run-131.txt`
- `docs/quickstart.md`
- `frontend/src/components/onboarding/AboutDialog.tsx`
- `frontend/src/components/onboarding/OnboardingOverlay.tsx`
- `frontend/src/components/primitives/Sidebar.tsx`
- `frontend/src/lib/methodsEngine.ts`
- `frontend/src/pages/Welcome.tsx`
- `infra/aws/README.md`
- `infra/aws/templates/user-data.sh`
- `infra/terraform/aws-ec2/scripts/complete-private-bootstrap.sh`
- `infra/terraform/aws-ec2/variables.tf`
- `scripts/cloud/bootstrap-x86-ubuntu.sh`

Then search the entire repository for the former URL, exercise all documentation
links, regenerate methods text, rerun the native-shell test, render Terraform,
and verify a fresh cloud bootstrap from the renamed repository.

## Release recommendation

Use **Neuravian 0.1.0 Early Access** for the first public release only after the
signed/notarized package and qualification evidence exist. Do not publish the
current release badge as proof that downloadable assets exist.

## Manual tasks before public rename

1. Rename the GitHub repository, then replace and verify every old repository
   URL in one change.
2. Rebuild screenshots and the GitHub social preview using the review queue.
3. Build, sign, notarize, install, launch, and uninstall the Neuravian desktop
   package on a clean supported Mac; verify its filenames, menus, Dock label,
   About dialog, shortcuts, permissions, and update metadata.
4. Back up local state before optionally migrating old database/AWS directories.
   Document any supported one-time migration; never bulk-rename active cloud
   resources or state files.
5. Remove stale generated `NeuroForge.app` bundles and caches only after the new
   package is independently verified. Historical qualification archives remain.
6. Confirm repository description, topics, security-advisory link, release
   links, CI badge, citation metadata, and deployment repository allowlists after
   GitHub completes the rename.

## Readiness

The maintained source is internally consistent with the exceptions above. A
public rename is **not complete** until the GitHub cutover, screenshot refresh,
and signed-package verification are performed. This report intentionally makes
no claim that a public download, homepage, release, or trademark exists.
