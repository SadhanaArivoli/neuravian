from types import SimpleNamespace

from app.services.pipeline import get_registry
from app.services.preflight import PreflightService


def _dataset(path):
    return SimpleNamespace(path=str(path), validation_status="valid")


def test_bids_app_preflight_rejects_missing_participant(tmp_path, monkeypatch):
    (tmp_path / "sub-01" / "anat").mkdir(parents=True)
    monkeypatch.setattr(
        "app.services.preflight.importlib.util.find_spec", lambda _: None
    )
    result = PreflightService().run(
        get_registry()["mriqc"],
        dataset=_dataset(tmp_path),
        params={"participant-label": "sub-99"},
        parameterized=True,
    )
    check = next(item for item in result.checks if item.id == "bids_participants")
    assert check.status == "fail"
    assert check.blocking is True
    assert result.can_launch is False


def test_bids_app_preflight_rejects_missing_session(tmp_path, monkeypatch):
    (tmp_path / "sub-01" / "ses-baseline").mkdir(parents=True)
    monkeypatch.setattr(
        "app.services.preflight.importlib.util.find_spec", lambda _: None
    )
    result = PreflightService().run(
        get_registry()["mriqc"],
        dataset=_dataset(tmp_path),
        params={"participant-label": "01", "session-id": "ses-followup"},
        parameterized=True,
    )
    check = next(item for item in result.checks if item.id == "bids_sessions")
    assert check.status == "fail"
    assert "followup" in check.message
