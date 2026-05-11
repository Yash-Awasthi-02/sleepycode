from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .artifacts import current_session_id, standard_metadata, write_json_artifact, write_markdown_artifact
from .ha_api import HomeAssistantClient, HomeAssistantError
from .markdown import load_frontmatter
from .policy import evaluate_references
from .simulate import collect_references


def _load_acknowledged(root: Path) -> dict[str, set[str]]:
    path = root / ".claude-code-hermit" / "compiled" / "acknowledged-violations.md"
    empty: dict[str, set[str]] = {"automation": set(), "script": set()}
    if not path.exists():
        return empty
    try:
        data, _ = load_frontmatter(path)
    except Exception as exc:
        print(f"Warning: acknowledged-violations.md has malformed frontmatter ({exc}) — violations not suppressed.", file=sys.stderr)
        return empty
    return {
        "automation": set(data.get("automation_ids") or []),
        "script": set(data.get("script_ids") or []),
    }


def _fetch_config(
    client: HomeAssistantClient, domain: str, state: dict[str, Any]
) -> tuple[str, Any]:
    """Fetch one domain config. Returns (kind, value) where kind is 'ok'|'unmanaged'|'failure'."""
    config_id = (state.get("attributes") or {}).get("id")
    if not config_id:
        return ("unmanaged", state["entity_id"])
    try:
        config = client.get(f"/api/config/{domain}/config/{config_id}")
        return ("ok", config)
    except HomeAssistantError as exc:
        if exc.status_code == 404:
            return ("failure", str(config_id))
        raise


def _run_audit(
    domain: str, root: Path, client: HomeAssistantClient, artifact_slug: str
) -> dict[str, Any]:
    all_states = client.get_states()
    domain_states = [
        s for s in all_states
        if isinstance(s, dict) and s.get("entity_id", "").startswith(f"{domain}.")
    ]
    total = len(domain_states)
    acknowledged_ids = _load_acknowledged(root).get(domain, set())

    unmanaged: list[str] = []
    fetch_failures: list[str] = []
    items: list[dict[str, Any]] = []

    max_workers = min(20, total) if total else 1
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(_fetch_config, client, domain, s) for s in domain_states]
        for future in as_completed(futures):
            kind, value = future.result()
            if kind == "unmanaged":
                unmanaged.append(value)
            elif kind == "failure":
                fetch_failures.append(value)
            elif isinstance(value, dict):
                items.append(value)

    violations: list[dict[str, Any]] = []
    acknowledged: list[dict[str, Any]] = []
    for item in items:
        entities, services = collect_references(item)
        decision = evaluate_references(sorted(set(entities)), sorted(set(services)), root=root)
        if decision.blocked:
            record = {
                "id": item.get("id"),
                "alias": item.get("alias") or item.get("id") or "(unnamed)",
                "reasons": decision.reasons,
            }
            if record["id"] in acknowledged_ids:
                acknowledged.append(record)
            else:
                violations.append(record)

    passed = total - len(violations) - len(acknowledged) - len(unmanaged) - len(fetch_failures)
    summary = {
        f"total_{domain}s": total,
        "violations": violations,
        "acknowledged": acknowledged,
        "passed": passed,
        "unmanaged": unmanaged,
        "fetch_failures": fetch_failures,
    }

    write_json_artifact(
        root,
        ".claude-code-hermit/raw",
        artifact_slug,
        summary,
        latest_name=f"{artifact_slug}-latest.json",
    )

    body_lines = [
        f"# HA Safety Audit ({domain}s)",
        "",
        f"- total {domain}s: {total}",
        f"- passed: {passed}",
        f"- violations: {len(violations)}",
    ]
    if acknowledged:
        body_lines.append(f"- acknowledged: {len(acknowledged)}")
    if unmanaged:
        body_lines.append(f"- unmanaged (no id, skipped): {len(unmanaged)}")
    if fetch_failures:
        body_lines.append(f"- fetch failures (404, skipped): {len(fetch_failures)}")
    if violations:
        body_lines.extend(["", "## Violations"])
        for v in violations:
            body_lines.append(f"- **{v['alias']}** (`{v['id']}`)")
            for reason in v["reasons"]:
                body_lines.append(f"  - {reason}")
    if acknowledged:
        body_lines.extend(["", "## Acknowledged"])
        for a in acknowledged:
            body_lines.append(f"- **{a['alias']}** (`{a['id']}`)")
            for reason in a["reasons"]:
                body_lines.append(f"  - {reason}")

    write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        artifact_slug,
        standard_metadata(
            "audit",
            f"HA Safety Audit ({domain}s)",
            session=current_session_id(root),
            tags=["ha-safety", "audit", "policy-drift"],
            extra={
                "source": "scheduled-check",
                f"total_{domain}s": total,
                "violations": len(violations),
                "acknowledged": len(acknowledged),
            },
        ),
        "\n".join(body_lines),
        latest_name=f"{artifact_slug}-latest.md",
    )
    return summary


def audit_automations(root: Path, client: HomeAssistantClient) -> dict[str, Any]:
    return _run_audit("automation", root, client, "audit-ha-safety")


def audit_scripts(root: Path, client: HomeAssistantClient) -> dict[str, Any]:
    return _run_audit("script", root, client, "audit-ha-script-safety")
