<div align="center">
  <img src="docs/assets/brand-mark.svg" width="112" alt="Open Pet Office logo">

# Open Pet Office

### A Codex desktop pet you can see

One supervisor pet lives on your desktop: live Codex tasks, one inbox for approvals and questions, and screenshots or files you can just drop in.<br>
When a job needs a team, turn on Delegation to run up to four workers in isolated workspaces, reviewed before anything is written back.

[简体中文](README.md) · [English](README_EN.md)

[![Latest release](https://img.shields.io/github/v/release/Gu-kai-lei/Open-Pet-Office?style=flat-square&color=F2A62B)](https://github.com/Gu-kai-lei/Open-Pet-Office/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Gu-kai-lei/Open-Pet-Office/total?style=flat-square&color=4C9AFF)](https://github.com/Gu-kai-lei/Open-Pet-Office/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Gu-kai-lei/Open-Pet-Office/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/Gu-kai-lei/Open-Pet-Office/actions/workflows/ci.yml)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=flat-square&logo=windows11)](#download-and-quick-start)
[![License](https://img.shields.io/github/license/Gu-kai-lei/Open-Pet-Office?style=flat-square&color=3DA639)](LICENSE)

**[Download for Windows](https://github.com/Gu-kai-lei/Open-Pet-Office/releases/latest)** · [Quick start](docs/GETTING_STARTED_EN.md) · [Report an issue](https://github.com/Gu-kai-lei/Open-Pet-Office/issues/new/choose)
</div>

![Open Pet Office: supervisor pet, multi-agent delegation, and live activity center](docs/assets/hero-v2.png)

> [!IMPORTANT]
> Open Pet Office is an early Windows preview. It already handles real projects, while its UI, protocols, and data model continue to evolve.

## Why Open Pet Office?

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🐾 Codex you can see</h3>
      <p>Whether a task starts in Codex Desktop, the CLI, or a pet, the supervisor shows its progress, and approvals and questions wait in one activity center.</p>
    </td>
    <td width="33%" valign="top">
      <h3>🧭 Delegation out of the box</h3>
      <p>Delegation uses a built-in coordinator and needs nothing beyond Codex CLI. The supervisor plans dependencies, dispatches waves, reviews each stage, reassigns failures, and performs the final review.</p>
    </td>
    <td width="33%" valign="top">
      <h3>🔒 Project-safe execution</h3>
      <p>Every worker runs in an isolated worktree or snapshot, and datasets or weights excluded by <code>.gitignore</code> are never copied. Conflicts, deletions, and out-of-scope writes pause instead of overwriting your files.</p>
    </td>
  </tr>
</table>

## Download and quick start

1. Download `Pet-Office-*-portable.exe` from the [latest Release](https://github.com/Gu-kai-lei/Open-Pet-Office/releases/latest).
2. Install and sign in to Codex CLI 0.155 or newer.
3. Run the app, hover over the supervisor pet, and click the compose icon.
4. Send a simple task directly, or enable Delegation for a project, agents, and models. Delegation uses the built-in coordinator, so there is nothing else to install.

> [!NOTE]
> The newest build on Releases is still v0.13.0. The v0.16 built-in coordinator, large-project isolation, and hardening require running from source (see "Run from source" below) until the next portable ships.

The public build is currently unsigned, so Windows SmartScreen may show an unknown-publisher warning. The Release page includes a SHA-256 digest for verification.

Want third-party models? The optional [OpenCodex](https://github.com/lidge-jun/opencodex) layer can route DeepSeek, GLM, and other providers into Codex. See the [getting started guide](docs/GETTING_STARTED_EN.md) for details.

## 📦 Latest

**v0.16.0 · 2026-10-24 (merged in source, portable pending) · Lightweight first**

- 🧭 Delegation now uses a **built-in coordinator** by default: no Node.js, npm or network install. Ruflo becomes an optional experimental engine; existing Ruflo Missions keep their engine.
- 🗂️ Isolated workspaces follow `.gitignore`, so datasets, model weights and build output are never copied to every worker. Oversized projects fail fast with a clear message, and only files about to be overwritten are backed up.
- 🔒 Hardening: renderer CSP, "open file" limited to folders and documents inside projects, allow-listed settings patches, and a backup before `~/.codex/config.toml` is changed.
- ⚡ Codex starts without `cmd.exe`, so arguments arrive verbatim; fullscreen detection uses one long-lived helper (≈0.5 s → a few ms per check).

> The public download is still v0.13.0; run from source until v0.16.0 portable ships. See [docs/PIVOT.md](docs/PIVOT.md) (Chinese) for the full review.

## 🚀 From one prompt to a reviewed delivery

```mermaid
flowchart LR
    A[Enter a task] --> B{Delegate?}
    B -- No --> C[Continue with one agent]
    B -- Yes --> D[Choose project / agents / models]
    D --> E[Supervisor creates dependency plan]
    E --> F[User confirms]
    F --> G[Workers execute in parallel waves]
    G --> H[Supervisor reviews the wave]
    H -->|Retry / reassign| G
    H --> I[Integrate and perform final review]
    I --> J{Conflict or risky change?}
    J -- Yes --> K[Wait for user]
    J -- No --> L[Write back safely]
```

With Delegation off, the pet is a lightweight entry point to a persistent Codex conversation. With Delegation on, the same composer becomes a recoverable Mission workflow.

## 🧰 What you get

| Capability | Experience |
| --- | --- |
| 🐾 **Live Codex tasks** | Read-only monitoring of local Codex sessions, including work started directly in Codex Desktop |
| 🧠 **1 + 4 agent team** | One supervisor and up to four workers, each with its own model |
| 🗂️ **Persistent Missions** | Dependency graph, execution waves, structured reports, stage reviews, reassignment, and restart recovery |
| 🧭 **Delegation engine** | Built-in coordinator by default with no extra install; Ruflo 3.43.0 can be enabled in Settings as an experimental engine |
| 🌳 **Isolated workspaces** | Git worktrees for clean repositories; snapshots for dirty Git and non-Git projects; both follow `.gitignore`, and oversized projects get a clear message |
| 📁 **Projects and sessions** | Create, continue, or reset context; rename, archive, restore, filter, and clean attachments |
| ✅ **Approvals and questions** | Handle command approvals, agent questions, conflicts, and recovery from one activity center |
| 📎 **File drop** | Drop files onto a pet to copy them into the project `inbox/` and attach relative paths |
| 📊 **Models and quota** | Codex five-hour and weekly limits, plus provider balances when APIs are available |
| 🎨 **Petdex appearances** | Multiple animated pets, with a direct route to discover more on Petdex |
| 🖥️ **Desktop reliability** | Multiple displays, fullscreen avoidance, tray controls, shortcuts, notification levels, and reduced motion |

## 🔔 Live status without interruption

The supervisor's live card shows the active model, task summary, current stage, and latest safe progress. With several tasks running, it shows the most recently updated task and the remaining count. Click it to return to the matching Codex task.

The bell activity center brings together:

- **Needs attention:** approvals, answers, conflicts, and recovery decisions
- **In progress:** Codex Desktop work, single-agent chats, and Missions
- **Recently finished:** accurate completion, interruption, failure, and cancellation states

Desktop updates are redacted and truncated. Full command output, system prompts, tokens, and secrets never belong in a pet bubble.

## 🌐 Multi-model collaboration

Open Pet Office uses Codex as the conversation and execution surface, with OpenCodex as an optional router for compatible providers. Every pet can select a different model. The supervisor can use code, vision, long-context, speed, and cost tags to recommend participants, while you retain final control over agents and models.

| Model source | Connection | Quota display |
| --- | --- | --- |
| OpenAI / Codex | Codex sign-in | Account-level five-hour and weekly remaining percentage |
| DeepSeek, GLM, and others | OpenCodex provider | Balance when the provider exposes a compatible API |
| Other Codex-visible models | Custom OpenCodex config | Added to the model catalog and selectable per agent |

## 🔒 How Missions protect your project

Mission plans and review records live under `.pet-office/` in the project. Runtime copies and complete logs live under `~/.pet-office/runtime/`. Workers write only to their own isolated environments; accepted work enters an integration workspace before the supervisor prepares write-back.

Isolated environments contain only the visible project files: datasets, weights, and build output excluded by `.gitignore` are not copied, and workers may read them from the main project only.

These conditions pause for user action:

- The main project changes while a Mission is running
- Several workers create a conflicting edit to the same file
- A task deletes files, writes outside its plan, or changes many binaries
- A node repeatedly fails, dependencies cannot proceed, or the app exits unexpectedly

Read [Architecture](docs/ARCHITECTURE_EN.md) for the module map, lifecycle, storage, and safety boundaries.

## 📚 Documentation

| Document | Contents |
| --- | --- |
| [Getting started](docs/GETTING_STARTED_EN.md) | Installation, first chat, Missions, file drop, and troubleshooting |
| [Architecture](docs/ARCHITECTURE_EN.md) | Modules, Mission lifecycle, isolation, local data, and safety boundaries |
| [Review and pivot](docs/PIVOT.md) (Chinese) | v0.16 findings, the reasons for the pivot, and next priorities |
| [Roadmap](docs/ROADMAP_EN.md) | Completed versions and next-stage direction |
| [Changelog](CHANGELOG.md) | Release additions and fixes |
| [Contributing](CONTRIBUTING.md) | Local development, tests, and pull request expectations |
| [Security](SECURITY.md) | Private vulnerability reporting |

## 🛠️ Run from source

```powershell
git clone https://github.com/Gu-kai-lei/Open-Pet-Office.git
cd Open-Pet-Office
npm install
npm test
npm start
```

Build the Windows portable executable with `npm run dist`.

If the portable build is also installed, keep a source run's data and Electron profile apart with `PET_OFFICE_HOME`:

```powershell
$env:PET_OFFICE_HOME = "$env:TEMP\pet-office-dev"
npm start
```

Tests cover session aggregation, partial and rotated JSONL, lifecycle states, redaction, activity-panel races, file ingestion, conversation recovery, Mission dependency and isolation behavior, the built-in coordinator, the Codex launcher, IPC and path safety, and per-release product contracts.

## 🛡️ Privacy and safety

- Session monitoring is strictly read-only.
- API keys, authorization headers, tokens, and passwords are redacted from desktop and crash summaries.
- Single-agent work keeps Codex sandbox and approval semantics.
- Mission workers can write only inside their isolated environments.
- The renderer runs under a strict Content-Security-Policy, and "open file" is limited to folders and documents inside your projects; executables are never launched.
- `~/.codex/config.toml` is backed up with a timestamp before Pet Office changes it.
- Codex starts directly instead of through `cmd.exe`, so arguments are never reinterpreted by a shell.
- Crash reports remain local and no telemetry is uploaded automatically.
- File drop copies the source; it never moves or deletes it.

Report security issues privately through [GitHub Security Advisories](https://github.com/Gu-kai-lei/Open-Pet-Office/security/advisories/new).

<details>
<summary><strong>Current limitations</strong></summary>

- Windows 10/11 is the current supported platform.
- Single-agent conversations use Codex App Server; Mission workers currently execute through parallel Codex CLI processes.
- The Ruflo engine is experimental and needs Node.js ≥ 20, npm ≥ 9, and a network install; the default built-in coordinator does not.
- Session Monitor depends on the local Codex JSONL format.
- `codex://threads/<id>` is still an experimental deep link.
- Petdex appearances are discovered in-app but not downloaded in-app yet.
- The current public portable build has no Windows code-signing certificate.

</details>

## 🤝 Contributing

Bug reports, interaction problems, and concrete new use cases are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and remove API keys, access tokens, and private conversation content from screenshots or logs.

- [Report a bug](https://github.com/Gu-kai-lei/Open-Pet-Office/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/Gu-kai-lei/Open-Pet-Office/issues/new?template=feature_request.yml)
- [View the roadmap](docs/ROADMAP_EN.md)

## Acknowledgements and trademarks

The interaction design draws inspiration from Codex pets, Munder Difflin, and multi-agent orchestration tools. OpenCodex is the optional model-routing layer, and Petdex is the optional appearance ecosystem.

Open Pet Office is a community project with no official affiliation with OpenAI, Petdex, model providers, or third-party pet artists. Codex, DeepSeek, and other names belong to their respective owners.

## License

[MIT](LICENSE) © Gu-kai-lei
