# SleepyCode — Autonomous Claude Code Orchestrator

Let Claude Code work while you sleep. SleepyCode watches over Claude Code via tmux, handles every interruption automatically, and uses DeepSeek as an independent brain — so when Anthropic credits die, the orchestrator stays alive.

---

## How It Works

```
You run sleepy.sh
    ↓
tmux session "sleepycode" created
    ↓
Claude Code runs inside the session
    ↓
watchdog.py polls tmux pane every 10s
    ↓
Detects pause → takes action:
  Credits gone  → kr rotate + y
  API error     → retry + resume
  Work done     → progress.md + /compact or /clear
  Question      → DeepSeek answers using roadmap
```

The watchdog reads the tmux pane output, classifies the state, and acts without human input. DeepSeek provides the decision layer — it reads your roadmap, interprets Claude's questions, and instructs the watchdog on what to send next.

---

## Why Two AI Providers

Claude Code (Anthropic) and the orchestrator brain (DeepSeek) run on completely separate billing accounts and independent API endpoints.

When Anthropic credits run out mid-session, Claude Code halts — but DeepSeek is unaffected. The watchdog detects the credit exhaustion pattern, DeepSeek confirms the recovery action, and the watchdog runs `kr rotate` followed by `y` to resume work automatically.

If both providers were on the same account or the same API, a credit failure would take down the entire system. The provider split is the resilience guarantee.

---

## Setup

```bash
git clone https://github.com/Yash-Awasthi-02/sleepycode
cd sleepycode

export ANTHROPIC_API_KEY=sk-ant-...
export DEEPSEEK_API_KEY=sk-...

./sleepy.sh "build the authentication module"
```

### Install as OS Service (always-on)

To run the watchdog as a persistent background service that survives reboots:

```bash
./install.sh
```

This registers the watchdog with systemd (Linux) or launchd (macOS) so it restarts automatically if the machine reboots or the process crashes.

---

## Roadmap Ingestion

If a `progress.md` or `ROADMAP.md` exists in the project directory, DeepSeek loads it at startup. When Claude Code asks a question or pauses on a decision, DeepSeek uses the roadmap as context to give an informed, project-aware answer rather than a generic one.

Place your roadmap in the project root before running `sleepy.sh` and it will be picked up automatically.

---

## Configuration

`config.json` controls watchdog behaviour:

| Key | Default | Description |
|-----|---------|-------------|
| `poll_interval` | `10` | Seconds between tmux pane reads |
| `max_retries` | `5` | API error retries before escalating |
| `session_name` | `sleepycode` | tmux session name |
| `deepseek_model` | `deepseek-chat` | DeepSeek model for orchestration decisions |
| `roadmap_file` | `auto` | Path to roadmap file, or `auto` to detect |

---

## How It Handles Each Scenario

**Credits exhausted**
Detected by matching Anthropic's credit exhaustion message in the pane output. Watchdog runs `kr rotate` to switch API key, then sends `y` to confirm and resume.

**API errors (500 / 503 / 529)**
Waits with exponential backoff and retries up to 5 times. If all retries fail, logs the error and notifies via configured channel.

**Work done**
When Claude Code signals task completion, the watchdog prompts it to write a `progress.md` summary, then issues `/compact` (or `/clear` if context is full) to free token budget before continuing with the next task.

**Claude asking a question**
DeepSeek receives the question along with the current roadmap context and replies with a concrete answer. The watchdog types the answer directly into the tmux pane.

---

## Foundation

Built on the watchdog pattern from [claude-code-hermit](https://github.com/gtapps/claude-code-hermit) by gtapps. Reimplemented in Python with DeepSeek orchestration and autonomous credit rotation.

---

## License

MIT
