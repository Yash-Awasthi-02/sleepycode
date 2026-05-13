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
3. Read body sections verbatim: `## Context`, `## Problem`, `## Proposed Solution`, `## Impact`.
4. Issue title: `[hermit/{category}] {title}`.
5. Append to body:
   ```
   ---
   *Filed via hermit-scribe · proposal={id} · session={session}*
   ```

For ad-hoc issues (no proposal): use the title and body the operator provides.

**Step 2: write title and body to temp files.**

Run `mktemp -d` and capture the path it prints to stdout (something like `/tmp/tmp.AbCdEf`). Shell state does not persist between Bash tool calls, so record the exact path from the output before using the Write tool.

Use the Write tool to create two files inside that directory. If the mktemp path was `/tmp/tmp.AbCdEf`, the files are:
- `/tmp/tmp.AbCdEf/title` containing the issue title only (single line, no markdown formatting).
- `/tmp/tmp.AbCdEf/body.md` containing the issue body markdown.

Passing both as files avoids any shell-quoting issues with title content.

**Step 3: run the script.**

Substitute the same path from step 2. If the mktemp path was `/tmp/tmp.AbCdEf`:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" /tmp/tmp.AbCdEf/title /tmp/tmp.AbCdEf/body.md
```

Capture stdout: it is the issue URL on success. Stderr has any error message.

**Step 4: report.**

On success: output `Filed: {url}`.

On error, surface the stderr. Common causes:
- `ENOENT` → `HERMIT_GH_APP_KEY_FILE` path is wrong or file is missing.
- `GH 401: Bad credentials` → wrong App ID, install ID, or key file.
- `GH 404` → App not installed on target repo, or repo name typo.
- `GH 422` → empty title or GH validation error.

## Notes

- `HERMIT_GH_REPO` overrides the default target (`gtapps/claude-code-hermit`).
- Running the skill twice on the same PROP-NNN creates two issues; no dedup. Operator's call.
- This skill does not write back to the proposal file.
