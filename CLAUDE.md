# CLAUDE.md

## Project Name

NeuroFlow: A Modern Open-Source Neuroimaging Workflow Platform

## Core Vision

Build the “VS Code of neuroimaging”: a modern, beginner-friendly, updateable platform that helps researchers, students, and labs work with existing neuroimaging tools through one guided interface.

This project should **not** replace validated tools such as FSL, FreeSurfer, ANTs, AFNI, fMRIPrep, MRIQC, FastSurfer, QSIPrep, Nilearn, DIPY, MRtrix3, or Connectome Workbench.

Instead, it should integrate, organize, explain, and simplify them.

The goal is to solve the practical problems users face when working with older or complex neuroimaging software:

- difficult installation
- confusing command-line workflows
- compatibility issues with newer datasets
- BIDS formatting problems
- unclear error messages
- scattered documentation
- long processing times
- difficult quality control
- hard-to-track preprocessing history
- lack of beginner-friendly explanations
- difficulty combining multiple tools into one reproducible workflow

## Product Philosophy

Do not reinvent existing scientific algorithms unless absolutely necessary.

The innovation should be in:

- usability
- integration
- reproducibility
- modularity
- workflow guidance
- dataset management
- error explanation
- visual pipeline building
- AI-assisted interpretation
- easier onboarding for students and new researchers
- updateable plugin architecture

Think of this project as a platform layer above existing open-source neuroimaging software.

## Important Constraints

1. Use free and open-source resources whenever possible.
2. Do not build a paid-API-dependent system.
3. Do not create a generic file manager or generic dashboard.
4. Do not simply copy existing platforms.
5. Do not start coding before creating architecture and planning documents.
6. Keep version 1 realistic for a student developer.
7. Build locally first, especially for macOS, then design for future Docker, cloud, and HPC support.
8. Medical imaging data must be treated as sensitive.
9. Prioritize reproducibility and provenance from the beginning.
10. Every pipeline action should be logged with software versions, parameters, inputs, outputs, and timestamps.

## Existing Tools to Respect and Integrate

The platform may eventually integrate:

- BIDS Validator
- HeuDiConv or dcm2bids
- dcm2niix
- fMRIPrep
- MRIQC
- FreeSurfer
- FastSurfer
- FSL
- ANTs
- AFNI
- QSIPrep
- QSIRecon
- Nilearn
- NiBabel
- Nipype
- Nextflow
- Snakemake
- DIPY
- MRtrix3
- Connectome Workbench
- Docker
- Apptainer/Singularity

Do not copy these tools. Wrap them, launch them, validate their presence, manage their outputs, explain their errors, and connect their results.

## What Makes This Project Different

Before designing features, always compare the idea against existing platforms and workflows.

This project should be different by focusing on:

- student-friendly onboarding
- guided neuroimaging workflows
- plain-English explanations
- compatibility help for older tools and newer datasets
- modular open-source architecture
- visual project organization
- integrated quality control
- reproducible logging
- AI-assisted troubleshooting without requiring paid APIs
- future plugin support

The project should not just be another pipeline runner. It should help users understand what is happening and why.

## Target Users

### Primary MVP User

A high school, undergraduate, or early graduate researcher who has MRI data but struggles with tools like FSL, FreeSurfer, fMRIPrep, and BIDS formatting.

### Secondary Users

- neuroscience labs
- research assistants
- imaging cores
- student research programs
- small nonprofit or academic research teams
- researchers running public datasets such as HCP, ABCD, or UK Biobank

### Future Users

- hospitals
- clinical research teams
- large labs
- multi-site studies

## MVP Scope

Version 1 should be realistic.

Focus on:

1. Local project creation.
2. BIDS dataset import and validation.
3. Dataset explorer.
4. Tool availability checker.
5. Simple pipeline templates.
6. Running external tools through wrappers.
7. Capturing logs and errors.
8. Beginner-friendly error explanations.
9. Basic quality-control report viewer.
10. Provenance tracking.
11. Simple local database.
12. Clean UI.
13. Documentation.

Recommended MVP pipeline support:

- BIDS validation
- MRIQC
- fMRIPrep launch support
- FreeSurfer/FastSurfer detection or optional execution
- Nilearn-ready output organization

Do not attempt to support every modality in version 1.

## Defer Until Later

Do not include these in the MVP unless the architecture is already stable:

- real-time collaboration
- clinical deployment
- HIPAA certification
- full cloud compute
- full HPC scheduler support
- custom deep learning model training
- full tractography workflow
- complex graph neural networks
- advanced 3D visualization
- multi-user permissions
- hospital PACS integration
- regulatory/clinical diagnosis features

These can be future roadmap items.

## Recommended Architecture Direction

Claude should first propose and justify the architecture before writing code.

A likely architecture:

- Desktop app: Tauri or Electron
- Frontend: React + TypeScript
- Backend/orchestration: Python
- Local database: SQLite
- Job queue: lightweight local queue first
- Tool execution: subprocess wrappers with structured logs
- Config format: YAML or JSON
- Plugin system: manifest-based plugin registry
- Dataset format: BIDS-first
- Container support: Docker first, Apptainer later
- AI assistant: optional local LLM support first, paid APIs optional but not required

Do not assume this is final. Claude should evaluate options and explain tradeoffs.

## Required Planning Output Before Coding

Before writing code, Claude must produce:

1. Problem statement.
2. Existing platform comparison.
3. Product differentiation.
4. User personas.
5. MVP definition.
6. Non-MVP features.
7. System architecture.
8. Frontend architecture.
9. Backend architecture.
10. Data model.
11. Local storage strategy.
12. Plugin system design.
13. Pipeline execution design.
14. External tool integration strategy.
15. Update strategy for external tools.
16. BIDS validation strategy.
17. Error explanation strategy.
18. Privacy/security plan.
19. Repository structure.
20. Development roadmap with 10–15 milestones.

## Development Rules

When generating code later:

1. Do not generate placeholder code unless explicitly requested.
2. Use production-quality structure even for MVP.
3. Keep modules small and understandable.
4. Prefer typed code.
5. Add clear comments only where useful.
6. Separate UI, orchestration, database, and tool wrappers.
7. Never hard-code user-specific paths.
8. Make paths configurable.
9. Do not assume all users have FSL, FreeSurfer, or Docker installed.
10. Always check whether external tools exist before trying to run them.
11. Log every command safely.
12. Never expose private file paths unnecessarily in the UI.
13. Provide clear recovery steps when something fails.
14. Prefer open standards.
15. Make every major feature testable.

## Neuroimaging-Specific Requirements

Every pipeline run should track:

- project ID
- subject ID
- session ID if applicable
- input files
- output files
- tool name
- tool version
- command executed
- parameters
- container image if used
- start time
- end time
- status
- warnings
- errors
- provenance metadata

Every dataset should track:

- BIDS validation status
- dataset description
- subjects
- sessions
- modalities
- missing files
- warnings
- suggested fixes

## Error Handling Philosophy

Most users will not understand raw neuroimaging errors.

For every failed command, the app should show:

1. What failed.
2. The likely cause.
3. Why it matters.
4. What the user can try next.
5. Link or reference to the relevant documentation.
6. Raw log access for advanced users.

Example:

Instead of only showing:

`recon-all exited with code 1`

Show:

“FreeSurfer failed during cortical reconstruction. This can happen if the T1 image has poor contrast, missing skull-stripping boundaries, corrupted input files, or incompatible orientation metadata. Try checking the input image, running MRIQC, confirming BIDS formatting, or using FastSurfer as an alternative.”

## AI Assistant Requirements

The AI assistant should help users understand and troubleshoot, but it should not make unsupported medical claims.

It may:

- explain tools
- summarize logs
- explain errors
- suggest next steps
- generate methods drafts
- generate figure captions
- recommend documentation
- explain BIDS
- explain preprocessing steps

It must not:

- diagnose patients
- make clinical claims
- pretend outputs are medically validated
- hide uncertainty
- invent citations
- claim a pipeline is publication-ready without evidence

The AI system should be optional and should support free/local models if possible.

## Privacy and Security

Assume MRI data may be sensitive.

The app should:

- run locally by default
- avoid uploading data without explicit user consent
- warn users before sending logs or metadata to external APIs
- support de-identification reminders
- avoid storing unnecessary personal information
- keep audit logs local
- clearly separate research use from clinical use

## Preferred First Claude Code Task

The first task should be architecture planning, not coding.

Claude should respond with a detailed architecture document and roadmap.

Use this prompt:

“I want to build this neuroimaging platform. Read CLAUDE.md carefully. Do not write code yet. First, produce the full architecture plan, MVP scope, existing tool comparison, system design, repository structure, and 10–15 milestone roadmap. Be realistic and critical. Focus on what makes this different from existing tools and how to keep it open-source, updateable, and student-buildable.”

## Definition of Success for Version 1

A successful MVP should allow a user to:

1. Create a neuroimaging project.
2. Import or select a BIDS dataset.
3. Validate the dataset.
4. See subjects, sessions, and modalities.
5. Check which external tools are installed.
6. Choose a simple pipeline template.
7. Launch a tool like MRIQC or fMRIPrep.
8. See progress and logs.
9. View output locations.
10. Read beginner-friendly explanations of failures.
11. Export a reproducibility/provenance summary.

If the MVP does this well, it is already valuable.

## Long-Term Vision

Long term, this could become a full open-source neuroimaging workbench with:

- visual pipeline builder
- plugin marketplace
- cloud/HPC execution
- advanced visualization
- publication figure generation
- automatic methods section generation
- multimodal MRI workflows
- connectomics analysis
- ML-ready dataset export
- lab collaboration features

But version 1 should stay focused.

Build the foundation first.
