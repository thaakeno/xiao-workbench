# Contributing to Xiao Workbench

Thanks for helping improve Xiao. Keep contributions focused, local-first, and
easy to review.

## Branch policy

- `main` contains stable, release-ready work.
- `dev` is the integration branch for active development.
- Create every feature or fix branch from the latest `dev`.
- Open pull requests against `dev`, **not `main`**. Pull requests to `main` will
  be asked to retarget before review.

## Start from `dev`

Fork the repository on GitHub, then clone your fork and add this repository as
`upstream`:

```powershell
git clone https://github.com/<YOUR-GITHUB-USERNAME>/xiao-workbench.git
cd xiao-workbench
git remote add upstream https://github.com/ryan-mt/xiao-workbench.git
git fetch upstream
git switch -c short-description upstream/dev
```

If you have direct write access, you can clone this repository and branch from
`origin/dev` instead. Use a short kebab-case branch name such as `session-fork`
or `fix-browser-nav`.

## Set up the project

You need Node.js 20 or newer, the stable Rust toolchain, and the Windows
dependencies required by Tauri 2. Install the Codex CLI if you want to test live
agent tasks.

```powershell
npm install
npm run tauri dev
```

## Before opening a pull request

Run the checks relevant to your change. For a full verification pass:

```powershell
npm run check
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Then push your branch to your fork:

```powershell
git push -u origin short-description
```

Open a pull request and select **`ryan-mt/xiao-workbench:dev` as the base
branch**.

## Pull request expectations

- Keep each pull request limited to one clear change.
- Explain the user-facing behavior and any important trade-offs.
- Add or update tests for behavior changes.
- Include screenshots or a short recording for visible UI changes.
- Use Conventional Commit messages, for example `feat: add session fork` or
  `fix(browser): handle invalid URLs`.
- Do not include unrelated formatting or refactors.

For large features or architectural changes, open an issue before implementation
so the direction can be agreed on first.

## Architecture boundaries

Xiao uses React and TypeScript for the interface and a Tauri/Rust host for
filesystem, Git, terminal, browser, and Codex operations. Keep privileged
workspace operations behind the typed Tauri bridge, preserve workspace path
scoping, and do not add analytics or remote storage without prior discussion.
