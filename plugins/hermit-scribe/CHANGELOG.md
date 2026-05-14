# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Fixed

- `HERMIT_GH_APP_KEY_FILE` path errors now surface a labeled message (`HERMIT_GH_APP_KEY_FILE='<path>' does not exist (cwd=<x>) — check .env`) instead of a raw `ENOENT` from deep in the JWT signing path.

### Added

- `--check <proposal-id>` flag on `file-issue.js`: queries open `hermit-filed` issues and matches on the `proposal={id}` footer. Exits 0 with the URL if found, 2 with "no match" if not. The skill runs this automatically before filing and surfaces the result to the operator.
- `issue-sanitizer` subagent: strips anything personal or specific to the operator's machine and project unless it's clearly part of an upstream hermit plugin. Always strips secrets, `.env` content, connection strings, internal hostnames/IPs, and non-public URLs even when they look technical. Single `<redacted>` placeholder; one principle the LLM applies rather than an exhaustive rule list. Operator un-redacts during the preview step if needed. Configured with `model: haiku`, `effort: low`, `maxTurns: 2` to cap cost.
- Operator preview gate: before invoking the script, the skill shows the sanitized title + body and asks the operator to confirm, edit, or cancel.
- Proposal frontmatter back-write: on successful file, the skill inserts `gh_issue: <url>` into the proposal's YAML frontmatter so `/proposal-list` and cortex views can show the linked issue without re-querying GitHub.

---

## [0.0.1] - 2026-05-13

### Added

- **Initial public release.**

### Upgrade Instructions

No previous version; first install. See README for GitHub App setup prerequisites.
