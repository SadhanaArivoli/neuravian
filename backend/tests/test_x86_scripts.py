from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).parents[2]
COMMAND_DIR = ROOT / "verification/x86/commands"
EXPECTED = [
    f"{index:02d}-{name}.sh"
    for index, name in enumerate(
        [
            "system-check",
            "neuroforge-health",
            "pydeface-verify",
            "fmriprep-verify",
            "fastsurfer-smoke",
            "fastsurfer-full",
            "output-validation",
            "collect-evidence",
            "stop-and-cleanup",
        ]
    )
]


def test_paid_session_command_set_is_complete_and_valid_shell() -> None:
    assert all((COMMAND_DIR / name).is_file() for name in EXPECTED)
    scripts = [
        ROOT / "scripts/cloud/bootstrap-x86-ubuntu.sh",
        ROOT / "verification/x86/prepull-images.sh",
        *(COMMAND_DIR / name for name in EXPECTED),
        COMMAND_DIR / "_common.sh",
    ]
    for script in scripts:
        subprocess.run(["bash", "-n", str(script)], check=True)


def test_paid_session_commands_are_strict_and_credential_free() -> None:
    for name in EXPECTED:
        text = (COMMAND_DIR / name).read_text()
        assert "set -euo pipefail" in text
        assert "AWS_ACCESS_KEY" not in text
        assert "/Users/" not in text
    long_commands = "\n".join(
        (COMMAND_DIR / name).read_text() for name in EXPECTED[2:6]
    )
    assert "TIMEOUT" in long_commands or "timeout" in long_commands
    assert "wait_for_run" in long_commands


def test_bootstrap_has_required_safe_arguments() -> None:
    text = (ROOT / "scripts/cloud/bootstrap-x86-ubuntu.sh").read_text()
    for flag in ("--commit", "--fixture-dir", "--prepull", "--dry-run"):
        assert flag in text
    assert "uname -m" in text
    assert "docker.com/linux/ubuntu" in text
    assert "aws " not in text.lower()
