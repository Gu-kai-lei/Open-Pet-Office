# Getting started

This guide takes you from installation to your first single-agent conversation and multi-agent Mission.

## Requirements

- Windows 10 or Windows 11 (x64)
- Codex CLI 0.155 or newer, signed in
- Optional: [OpenCodex](https://github.com/lidge-jun/opencodex) for routing DeepSeek, GLM, and other providers through Codex

## Install

Download `Pet-Office-*-portable.exe` from the [latest Release](https://github.com/Gu-kai-lei/Open-Pet-Office/releases/latest) and run it. The supervisor pet appears on your desktop. Right-click it to hide the app, summon workers, or exit.

For Canvas, drag an address-bar, course, or assignment link directly onto a pet. Press `Ctrl + Alt + S` (or choose **Screenshot question** from the pet menu, or type `/screenshot`) to capture a region. The image is only attached to the composer; it is not sent until you add a question and confirm. Login-only Canvas pages may not be readable from a URL alone, so attach a screenshot or downloaded file when needed.

The current public build is unsigned, so Windows SmartScreen may show an unknown-publisher warning. Verify the SHA-256 value on the Release page when needed.

## Your first conversation

1. Hover over the supervisor pet.
2. Click the compose icon; the button expands into the composer.
3. Keep Delegation off and send your message.
4. The live card shows task summary and current stage. Click it to open the matching Codex task.

## Your first Mission

1. Open the composer and enable Delegation.
2. Select or create a project workspace.
3. Select agents and models, or start with the automatic recommendation.
4. Review the supervisor's dependency-wave plan and confirm it.
5. Workers execute in isolation; the supervisor reviews every completed wave.
6. Accepted work enters an integration workspace. Conflicts, deletions, and out-of-scope writes pause for you.

## Drop files onto a pet

Drop files onto a pet or an open composer. Pet Office copies them into the active project's `inbox/` and adds their relative paths to the prompt. Source files are never moved or deleted.

## Useful entry points

| Action | Entry point |
| --- | --- |
| Tasks, approvals, and questions | Bell below the supervisor |
| Model and quota | Left-click a pet → Overview |
| Projects and sessions | Left-click supervisor → Work |
| Pet appearance | Left-click a pet → Appearance |
| Displays, fullscreen, and notifications | Left-click supervisor → Settings |
| Hide while tasks keep running | Right-click supervisor → Hide to tray |

## Run from source

```powershell
git clone https://github.com/Gu-kai-lei/Open-Pet-Office.git
cd Open-Pet-Office
npm install
npm test
npm start
```

Build the Windows portable executable with `npm run dist`.

## Troubleshooting

### Codex Desktop work does not appear

Run Connection diagnostics from the supervisor's Settings page. Pet Office reads `~/.codex/sessions` incrementally and never edits session logs.

### A provider has no quota display

Provider billing APIs are not standardized. Supported providers show their balance; otherwise Pet Office explicitly marks quota as unavailable instead of presenting a local token estimate as account balance.

### A task card cannot open its conversation

`codex://threads/<id>` remains experimental. Confirm that Codex Desktop is installed and has registered the protocol handler.

### Where can I find more appearances?

Click Discover appearances on the Appearance page to open [Petdex](https://petdex.dev/). Check the license of third-party art before redistributing it.
