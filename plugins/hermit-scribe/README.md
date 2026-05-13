<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.1-green.svg" alt="Version 0.0.1" /></a>
</p>

# hermit-scribe

Files GitHub issues via a configured GitHub App so they're attributed to a bot identity rather than a personal account. Pure Node stdlib; no dependencies, no build step. Maintainer tool.

## Install

```bash
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install hermit-scribe@claude-code-hermit --scope project
```

## GitHub App setup

The plugin requires a GitHub App with `Issues: Read & write` permission installed on the target repo.

1. **GitHub Settings → Developer settings → GitHub Apps → New GitHub App.**
2. Name the App (this name becomes the bot identity on filed issues). Set Homepage URL to anything; disable Webhook.
3. **Permissions → Repository permissions → Issues**: `Read & write`.
4. **Create GitHub App.** Note the **App ID** on the settings page.
5. **Private keys → Generate a private key.** Save the `.pem`.
6. **Install App**, choose account/org, select target repo(s).
7. The installation URL is `github.com/settings/installations/{INSTALL_ID}`. Note the ID.

Store the key in a gitignored location:

```bash
mkdir -p .claude/secrets
mv ~/Downloads/<your-app>.*.pem .claude/secrets/hermit-scribe-key.pem
```

## Env vars

| Var | Description |
|-----|-------------|
| `HERMIT_GH_APP_ID` | App ID from the App's settings page |
| `HERMIT_GH_APP_INSTALL_ID` | Install ID from the installation URL |
| `HERMIT_GH_APP_KEY_FILE` | Absolute path to the `.pem` private key |
| `HERMIT_GH_REPO` | Optional. Target `owner/repo`. Default: `gtapps/claude-code-hermit` |

Set them in your project `.env` (loaded by Docker hermit via `env_file:`) or in `.claude/settings.local.json` `env` block for interactive sessions.

## Usage

Trigger phrases:

- `file PROP-007 as a GH issue`
- `open an issue for PROP-012`
- `report this to the tracker`
- `file a GH issue for [description]`

For proposal-backed issues: the skill globs `.claude-code-hermit/proposals/PROP-NNN-*.md`, reads frontmatter (`id`, `title`, `category`, `session`) and the `## Context` / `## Problem` / `## Proposed Solution` / `## Impact` body sections, then formats title as `[hermit/{category}] {title}` and appends a `Filed via hermit-scribe · proposal={id} · session={session}` footer.

For ad-hoc: supply title and body directly.

All issues get the `hermit-filed` label. No dedup; running twice creates two issues.

## Errors

| Error | Cause |
|-------|-------|
| `ENOENT` | Key file path wrong or missing |
| `GH 401: Bad credentials` | Wrong App ID, install ID, or key file |
| `GH 404` | App not installed on target repo, or repo name typo |
| `GH 422` | Empty title or GitHub validation error |
| `HERMIT_GH_REPO must be "owner/repo"` | Malformed repo path (more than one `/`) |

## Safety

- `*.pem` is gitignored. Private key never committed.
- Key is read at runtime; never appears in session files, proposals, or memory.
- Missing env vars produce a clear error and non-zero exit. No silent no-ops.

## Architecture

```
hermit-scribe/
  └── skills/hermit-scribe/
        ├── SKILL.md        trigger phrases + filing instructions
        └── file-issue.js   stdlib: JWT → install token → POST /issues
```

`file-issue.js` is a single-shot Node script: signs an RS256 JWT from the App private key, exchanges it for an installation access token at `POST /app/installations/{id}/access_tokens`, then `POST /repos/{owner}/{repo}/issues` with the `hermit-filed` label. Two HTTPS round-trips per invocation. Node is required (Claude Code already provides it).

## License

[MIT](LICENSE)
