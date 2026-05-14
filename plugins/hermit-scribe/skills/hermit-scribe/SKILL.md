---
name: hermit-scribe
description: File a GitHub issue on the configured repository via a GitHub App bot identity. Use when the operator says "file as a GH issue", "open an issue for PROP-NNN", "report this to the tracker", or similar. Requires HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE in env.
---

# hermit-scribe

Files a GitHub issue via a configured GitHub App bot identity.

## When to activate

Activate when the operator says:
- "file PROP-NNN as a GH issue"
- "open an issue for this"
- "report this to the tracker"
- "file a GH issue for [description]"

## How to file

**Step 1: resolve content.**

If the operator named a proposal (`PROP-NNN`):
1. Glob `.claude-code-hermit/proposals/PROP-NNN-*.md` to find the file.
2. Read frontmatter: `id`, `title`, `category`, `session`.
3. Read body sections: `## Context`, `## Problem`, `## Proposed Solution`, `## Impact`.
4. Construct draft title: `[hermit/{category}] {title}`.
5. Construct draft body with the four body sections, then append:
   ```
   ---
   *Filed via hermit-scribe · proposal={id} · session={session}*
   ```

For ad-hoc issues (no proposal): use the title and body the operator provides.

**Step 2: dedup check.** (proposal-backed only — skip for ad-hoc issues)

Run:
```bash
node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" --check {id}
```

- Exit 0 + URL printed → an issue already exists for this proposal. Show the URL to the operator and ask whether to skip filing or proceed anyway.
- Exit 2 → no existing issue. Continue.

**Step 3: sanitize.**

Pass the draft title and body to the `hermit-scribe:issue-sanitizer` subagent:

```
DRAFT_TITLE: {draft title}
DRAFT_BODY:
{draft body}
```

Parse the response: split on the `<<<HERMIT_SCRIBE_BODY>>>` line. Everything before it (after stripping `TITLE: `) is the cleaned title; everything after is the cleaned body.

**Step 4: operator preview.**

Print the cleaned title and body to the operator:

```
--- PREVIEW ---
Title: {cleaned title}

{cleaned body}
--- END PREVIEW ---

File this issue? (yes / edit / cancel)
```

Wait for the operator's response. On "edit": apply any requested changes to title or body. On "cancel": abort. Proceed only on "yes" or after applying edits.

**Step 5: write title and body to temp files.**

Run `mktemp -d` and capture the path it prints to stdout (something like `/tmp/tmp.AbCdEf`). Shell state does not persist between Bash tool calls, so record the exact path from the output before using the Write tool.

Use the Write tool to create two files inside that directory:
- `/tmp/tmp.AbCdEf/title` — the cleaned issue title (single line, no markdown formatting).
- `/tmp/tmp.AbCdEf/body.md` — the cleaned issue body markdown.

**Step 6: run the script.**

Substitute the same path from step 5:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" /tmp/tmp.AbCdEf/title /tmp/tmp.AbCdEf/body.md
```

Capture stdout: it is the issue URL on success. Stderr has any error message.

**Step 7: back-write and report.**

On success:
1. Use the Edit tool to insert `gh_issue: {url}` into the proposal's YAML frontmatter, on a new line directly after the `id:` field. Skip this step for ad-hoc issues (no proposal file).
2. Output `Filed: {url}`.

On error, surface the stderr. Common causes:
- `HERMIT_GH_APP_KEY_FILE='...' does not exist` → key file path is wrong or file is missing — check `.env`.
- `GH 401: Bad credentials` → wrong App ID, install ID, or key file.
- `GH 404` → App not installed on target repo, or repo name typo.
- `GH 422` → empty title or GH validation error.

## Notes

- `HERMIT_GH_REPO` overrides the default target (`gtapps/claude-code-hermit`).
- If the operator overrides the dedup check and re-files the same proposal, `gh_issue` in the frontmatter is overwritten with the new URL (latest wins).
- The `issue-sanitizer` subagent strips anything personal or specific to the operator's machine and project unless it's clearly part of an upstream hermit plugin. It does not edit for style or clarity — only for privacy.
