# Changelog

All notable changes to the Xiao Workbench fork are documented here. The project follows Conventional Commits and keeps the release surface local-first: no telemetry, no Xiao account, and no developer-controlled user database.

## Unreleased

### Runtime and history

- Added optional import of local Codex task history with persisted titles, project grouping, standalone “Other Codex chats,” realtime active-state spinners, and frame-batched streaming for the selected task.
- Added direct Codex app-server account, usage, model, rate-limit, and task integration without copying credentials to an external service.
- Preserved imported tasks as continuable native Xiao tasks and corrected stale or missing runtime-generation foreign keys.
- Merged upstream SQLite persistence and retained the fork’s custom history, usage, profile, and task experience.
- Normalized Windows verbatim and UNC paths before Git subprocess calls so valid repositories expose branch and review state.

### Performance

- Added cached project, thread, usage, capability, and change-summary snapshots so useful UI is visible immediately during background refresh.
- Removed full workspace reloads when moving between imported tasks in the same project.
- Frame-batched streaming deltas and stopped rebuilding every historical timeline item per token.
- Kept sidebar ordering chronological and stable instead of moving selected tasks into an Active group.
- Reduced layout shifts, horizontal canvas movement, startup flashes, timeline overflow, and expensive active-thread transitions.
- Added bounded lists, custom scrollbars, and fixed-height magnetic message navigation for large histories.

### Conversation design

- Added one per-turn “Worked for” execution wrapper using each turn’s recorded duration; active timing no longer leaks into every historical turn.
- Removed noisy standalone thought rows and grouped visible commands, searches, integrations, and file work under the execution wrapper.
- Added collapsible edited-file cards with clean relative paths, aggregate additions/deletions, and compact completed batches.
- Added clamped user messages, “Show more,” compact image attachments, composer previews, and a full lightbox.
- Added message timestamps, copy actions, scroll-to-bottom controls, rich timeline previews, source icons, and compact session-compaction treatment.
- Added dockable terminal placement and a Ctrl+J toggle.
- Added right-click actions for project tasks and standalone Codex tasks.

### Usage and configuration

- Added local token analytics, live quota refresh, activity history, daily trends, by-model totals, conversation ranking, cached-input visibility, and API-equivalent cost labeling.
- Added a unified model, reasoning-effort, and fast-mode control with model icons and official published API rates where available.
- Added granular transcript export for user messages, agent responses, tools, commands, outputs, and recorded summaries.
- Added exact tokenizer counts for the visible exported transcript. These are not represented as subscription billing.

### Capabilities

- Added instant cached Skills, plugin, MCP, and app discovery with bounded MCP timeout and background repair.
- Added capability status cards and a local syntax-highlighted skill editor that reads and writes through the Codex app-server.
- Kept capability data local and avoided developer-hosted registration or analytics.

### Desktop integration

- Added native completion, approval, error, and usage notifications.
- Added Windows autostart with foreground and quiet background/tray modes.
- Added verified upstream update checks, download progress events, SHA-256 validation, silent installer launch, and restart.
- Added an in-app What’s New view and a privacy-conscious GitHub issue composer with local drag-and-drop validation.
- Added the orange mushroom application artwork to packaged Windows surfaces.

### Release engineering

- Added `tools/release.ps1` with remote allowlisting, clean-tree enforcement, one final validation pass, NSIS packaging, SHA-256 output, Conventional Commit release notes, fork-only push, annotated tag, and GitHub release creation.
- Added an MIT license declaration and this detailed changelog.
- Kept `ARCHITECTURE.md` and local OpenKnowledge metadata out of release commits.

## Upstream foundation

The fork remains based on Ryan M. T.’s Xiao Workbench. Upstream supplied the native Tauri shell, Codex app-server transport, SQLite-backed workspace persistence, managed execution/runtime services, terminal, Git operations, routine scheduling, and project architecture on which these fork changes build.
