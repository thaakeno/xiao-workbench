<p align="center">
  <img src="src-tauri/icons/app-icon.png" alt="Xiao Workbench mushroom logo" width="180" />
</p>

<h1 align="center">Xiao Workbench</h1>

<p align="center"><strong>Windows beta · 0.0.0day07162026</strong></p>

Xiao is a calm desktop desk for noisy agent work. The conversation stays in the
middle; the plan, files, changes, terminal, browser, and the occasional break
stay close enough to reach without turning the whole screen into a dashboard.

It is local-first and built with Tauri, Rust, React, and TypeScript. Xiao talks
to the Codex app server installed on your machine instead of hiding another
agent runtime behind a remote web app.

## What is inside this beta

- Streaming Codex tasks with tool activity, approvals, plans, and follow-ups.
- A Focus Rail for files, diffs, repository actions, runtime context, and a real
  native terminal.
- A small research browser that opens on Google and can handle normal web pages
  such as YouTube.
- Xiao Break, a muted game panel for the minutes when an agent is still working.
- Light, dark, and system themes in a compact Windows-native shell.
- Workspace and Git operations implemented in the Rust host and scoped to the
  project you opened.

The shape is intentionally simple:

```text
React workspace  <->  Tauri IPC  <->  Rust host
                                      |-- Codex app-server
                                      |-- Git + filesystem
                                      `-- native PTY
```

## Download the Windows beta

Open the repository's **Releases** page and choose the newest release marked
**Pre-release**. The `.exe` installer is the easiest route; an `.msi` package is
also provided when available.

This beta is not code-signed yet, so Windows SmartScreen may ask you to confirm
the installer. Only use artifacts attached to the release published from this
repository.

For live agent tasks, install the Codex CLI and sign in before opening Xiao.
The browser and Xiao Break require an internet connection; ordinary workspace,
Git, and terminal features stay on your machine.

## Run it from source

You will need Node.js 20 or newer, the stable Rust toolchain, the Windows
dependencies required by Tauri 2, and optionally the Codex CLI.

```powershell
npm install
npm run tauri dev
```

To verify the same paths used for this beta:

```powershell
npm run check
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## Contributing

Active development happens on the
[`dev`](https://github.com/ryan-mt/xiao-workbench/tree/dev) branch. Create
feature branches from `dev` and target pull requests back to `dev`, not `main`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, and pull request
guidance.

## A beta, honestly

Xiao is usable, but this is still the first public beta. Native WebViews,
installer behavior, and long-running agent sessions need more miles on more
Windows machines. If something feels awkward, open an issue with what you were
doing, what you expected, and a screenshot when it helps. That kind of report is
far more useful than a perfect bug-report template.

Xiao does not add its own analytics. Websites opened in the browser keep their
own privacy policies, and Codex follows the account and configuration of your
local Codex installation.

## License

Xiao Workbench is open-source software available under the
[MIT License](LICENSE).
