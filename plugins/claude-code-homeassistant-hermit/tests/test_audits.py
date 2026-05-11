from __future__ import annotations

import json
import pytest
from pathlib import Path

from ha_agent_lab.audits import audit_automations, audit_scripts, _load_acknowledged
from ha_agent_lab.ha_api import HomeAssistantError


class FakeClient:
    def __init__(self, responses: dict[str, object]) -> None:
        self._responses = responses
        self.calls: list[str] = []

    def get(self, path: str) -> object:
        self.calls.append(path)
        if path not in self._responses:
            raise KeyError(f"unexpected path: {path}")
        value = self._responses[path]
        if isinstance(value, Exception):
            raise value
        return value

    def get_states(self) -> object:
        return self.get("/api/states")


def _make_state(entity_id: str, config_id: str | None) -> dict:
    attrs = {"id": config_id} if config_id is not None else {}
    return {"entity_id": entity_id, "state": "on", "attributes": attrs}


# ---------------------------------------------------------------------------
# audit_automations
# ---------------------------------------------------------------------------

def test_audit_automations_flags_sensitive_references(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    configs = {
        "safe_kitchen": {
            "id": "safe_kitchen",
            "alias": "Kitchen motion light",
            "trigger": [{"platform": "state", "entity_id": "binary_sensor.kitchen_motion"}],
            "action": [{"service": "light.turn_on", "target": {"entity_id": "light.kitchen"}}],
        },
        "garage_auto_close": {
            "id": "garage_auto_close",
            "alias": "Close garage at night",
            "trigger": [{"platform": "time", "at": "23:00:00"}],
            "action": [{"service": "cover.close_cover", "target": {"entity_id": "cover.garage_door"}}],
        },
    }
    states = [
        _make_state("automation.safe_kitchen", "safe_kitchen"),
        _make_state("automation.garage_auto_close", "garage_auto_close"),
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/safe_kitchen": configs["safe_kitchen"],
        "/api/config/automation/config/garage_auto_close": configs["garage_auto_close"],
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 2
    assert summary["passed"] == 1
    assert len(summary["violations"]) == 1
    assert summary["acknowledged"] == []
    assert summary["unmanaged"] == []
    assert summary["fetch_failures"] == []
    violation = summary["violations"][0]
    assert violation["id"] == "garage_auto_close"
    assert any("garage_door" in r for r in violation["reasons"])

    latest = tmp_path / ".claude-code-hermit" / "raw" / "audit-ha-safety-latest.json"
    assert latest.exists()
    persisted = json.loads(latest.read_text(encoding="utf-8"))
    assert persisted["violations"] == summary["violations"]


def test_audit_automations_no_violations(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    config = {
        "id": "bedtime_dim",
        "alias": "Dim bedroom at bedtime",
        "action": [{"service": "light.turn_on", "target": {"entity_id": "light.bedroom"}}],
    }
    states = [_make_state("automation.bedtime_dim", "bedtime_dim")]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/bedtime_dim": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 1
    assert summary["violations"] == []
    assert summary["acknowledged"] == []
    assert summary["passed"] == 1
    assert summary["unmanaged"] == []
    assert summary["fetch_failures"] == []


def test_audit_automations_handles_unmanaged_and_fetch_failures(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    states = [
        _make_state("automation.yaml_only", None),       # no numeric id — unmanaged
        _make_state("automation.missing_config", "999"),  # 404 on config fetch
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/999": HomeAssistantError(message="not found", status_code=404),
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 2
    assert summary["unmanaged"] == ["automation.yaml_only"]
    assert summary["fetch_failures"] == ["999"]
    assert summary["violations"] == []
    assert summary["acknowledged"] == []
    # invariant: passed + violations + acknowledged + unmanaged + fetch_failures == total
    total = summary["total_automations"]
    assert (
        summary["passed"]
        + len(summary["violations"])
        + len(summary["acknowledged"])
        + len(summary["unmanaged"])
        + len(summary["fetch_failures"])
        == total
    )


def test_audit_automations_propagates_unexpected_errors(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    states = [_make_state("automation.broken", "broken_id")]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/broken_id": HomeAssistantError(message="server error", status_code=500),
    }
    client = FakeClient(responses)

    with pytest.raises(HomeAssistantError) as exc_info:
        audit_automations(tmp_path, client)

    assert exc_info.value.status_code == 500


def test_audit_automations_moves_acknowledged_to_acknowledged_bucket(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    compiled = tmp_path / ".claude-code-hermit" / "compiled"
    compiled.mkdir(parents=True)
    (compiled / "acknowledged-violations.md").write_text(
        "---\nautomation_ids: [garage_auto_close]\nscript_ids: []\n---\n",
        encoding="utf-8",
    )

    states = [
        _make_state("automation.safe_kitchen", "safe_kitchen"),
        _make_state("automation.garage_auto_close", "garage_auto_close"),
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/safe_kitchen": {
            "id": "safe_kitchen",
            "action": [{"service": "light.turn_on", "target": {"entity_id": "light.kitchen"}}],
        },
        "/api/config/automation/config/garage_auto_close": {
            "id": "garage_auto_close",
            "alias": "Close garage at night",
            "action": [{"service": "cover.close_cover", "target": {"entity_id": "cover.garage_door"}}],
        },
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["violations"] == []
    assert len(summary["acknowledged"]) == 1
    assert summary["acknowledged"][0]["id"] == "garage_auto_close"
    assert summary["passed"] == 1


# ---------------------------------------------------------------------------
# audit_scripts
# ---------------------------------------------------------------------------

def test_audit_scripts_flags_sensitive_references(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    configs = {
        "safe_lights": {
            "id": "safe_lights",
            "alias": "Turn off lights",
            "sequence": [{"service": "light.turn_off", "target": {"entity_id": "light.living_room"}}],
        },
        "unlock_front": {
            "id": "unlock_front",
            "alias": "Unlock front door",
            "sequence": [{"service": "lock.unlock", "target": {"entity_id": "lock.front_door"}}],
        },
    }
    states = [
        _make_state("script.safe_lights", "safe_lights"),
        _make_state("script.unlock_front", "unlock_front"),
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/script/config/safe_lights": configs["safe_lights"],
        "/api/config/script/config/unlock_front": configs["unlock_front"],
    }
    client = FakeClient(responses)

    summary = audit_scripts(tmp_path, client)

    assert summary["total_scripts"] == 2
    assert summary["passed"] == 1
    assert len(summary["violations"]) == 1
    assert summary["acknowledged"] == []
    assert summary["unmanaged"] == []
    assert summary["fetch_failures"] == []
    violation = summary["violations"][0]
    assert violation["id"] == "unlock_front"
    assert any("front_door" in r or "lock" in r for r in violation["reasons"])

    latest = tmp_path / ".claude-code-hermit" / "raw" / "audit-ha-script-safety-latest.json"
    assert latest.exists()
    persisted = json.loads(latest.read_text(encoding="utf-8"))
    assert persisted["violations"] == summary["violations"]


def test_audit_scripts_no_violations(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    config = {
        "id": "morning_lights",
        "alias": "Morning lights on",
        "sequence": [{"service": "light.turn_on", "target": {"entity_id": "light.kitchen"}}],
    }
    states = [_make_state("script.morning_lights", "morning_lights")]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/script/config/morning_lights": config,
    }
    client = FakeClient(responses)

    summary = audit_scripts(tmp_path, client)

    assert summary["total_scripts"] == 1
    assert summary["violations"] == []
    assert summary["acknowledged"] == []
    assert summary["passed"] == 1
    assert summary["unmanaged"] == []
    assert summary["fetch_failures"] == []


def test_audit_scripts_handles_unmanaged_and_fetch_failures(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    states = [
        _make_state("script.yaml_only", None),
        _make_state("script.missing_config", "ghost_script"),
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/script/config/ghost_script": HomeAssistantError(message="not found", status_code=404),
    }
    client = FakeClient(responses)

    summary = audit_scripts(tmp_path, client)

    assert summary["total_scripts"] == 2
    assert summary["unmanaged"] == ["script.yaml_only"]
    assert summary["fetch_failures"] == ["ghost_script"]
    assert summary["violations"] == []
    assert summary["acknowledged"] == []
    total = summary["total_scripts"]
    assert (
        summary["passed"]
        + len(summary["violations"])
        + len(summary["acknowledged"])
        + len(summary["unmanaged"])
        + len(summary["fetch_failures"])
        == total
    )


def test_audit_scripts_propagates_unexpected_errors(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    states = [_make_state("script.broken", "broken_script")]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/script/config/broken_script": HomeAssistantError(message="server error", status_code=500),
    }
    client = FakeClient(responses)

    with pytest.raises(HomeAssistantError) as exc_info:
        audit_scripts(tmp_path, client)

    assert exc_info.value.status_code == 500


def test_audit_scripts_moves_acknowledged_to_acknowledged_bucket(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    compiled = tmp_path / ".claude-code-hermit" / "compiled"
    compiled.mkdir(parents=True)
    (compiled / "acknowledged-violations.md").write_text(
        "---\nautomation_ids: []\nscript_ids: [unlock_front]\n---\n",
        encoding="utf-8",
    )

    states = [
        _make_state("script.safe_lights", "safe_lights"),
        _make_state("script.unlock_front", "unlock_front"),
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/script/config/safe_lights": {
            "id": "safe_lights",
            "sequence": [{"service": "light.turn_off", "target": {"entity_id": "light.living_room"}}],
        },
        "/api/config/script/config/unlock_front": {
            "id": "unlock_front",
            "alias": "Unlock front door",
            "sequence": [{"service": "lock.unlock", "target": {"entity_id": "lock.front_door"}}],
        },
    }
    client = FakeClient(responses)

    summary = audit_scripts(tmp_path, client)

    assert summary["violations"] == []
    assert len(summary["acknowledged"]) == 1
    assert summary["acknowledged"][0]["id"] == "unlock_front"
    assert summary["passed"] == 1


# ---------------------------------------------------------------------------
# _load_acknowledged
# ---------------------------------------------------------------------------

def test_load_acknowledged_empty_when_file_missing(tmp_path: Path) -> None:
    result = _load_acknowledged(tmp_path)
    assert result == {"automation": set(), "script": set()}


def test_load_acknowledged_reads_automation_and_script_ids(tmp_path: Path) -> None:
    compiled = tmp_path / ".claude-code-hermit" / "compiled"
    compiled.mkdir(parents=True)
    (compiled / "acknowledged-violations.md").write_text(
        "---\nautomation_ids: [garage_auto_close, morning_routine]\nscript_ids: [unlock_front]\n---\n\nbody text\n",
        encoding="utf-8",
    )

    result = _load_acknowledged(tmp_path)

    assert result["automation"] == {"garage_auto_close", "morning_routine"}
    assert result["script"] == {"unlock_front"}


def test_load_acknowledged_tolerates_empty_lists(tmp_path: Path) -> None:
    compiled = tmp_path / ".claude-code-hermit" / "compiled"
    compiled.mkdir(parents=True)
    (compiled / "acknowledged-violations.md").write_text(
        "---\nautomation_ids: []\nscript_ids: []\n---\n",
        encoding="utf-8",
    )

    result = _load_acknowledged(tmp_path)

    assert result["automation"] == set()
    assert result["script"] == set()


def test_load_acknowledged_tolerates_missing_fields(tmp_path: Path) -> None:
    compiled = tmp_path / ".claude-code-hermit" / "compiled"
    compiled.mkdir(parents=True)
    (compiled / "acknowledged-violations.md").write_text(
        "---\ntitle: Acknowledged\n---\n",
        encoding="utf-8",
    )

    result = _load_acknowledged(tmp_path)

    assert result["automation"] == set()
    assert result["script"] == set()
