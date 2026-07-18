[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')] [string] $Tag,
    [string] $Remote = 'fork',
    [string] $Repository = 'thaakeno/xiao-workbench',
    [switch] $Draft,
    [switch] $SkipValidation
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

function Invoke-Checked([string] $Program, [string[]] $Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE." }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
Invoke-Checked gh @('auth', 'status')

$remoteUrl = (git remote get-url $Remote).Trim()
if ($LASTEXITCODE -ne 0 -or $remoteUrl -notmatch [regex]::Escape($Repository)) {
    throw "Remote '$Remote' does not point to the permitted fork '$Repository'. Refusing to publish."
}
$dirty = git status --porcelain
if ($dirty) { throw 'The worktree must be clean before a release.' }
if (git tag --list $Tag) { throw "Tag $Tag already exists locally." }

if (-not $SkipValidation) {
    Invoke-Checked npm @('run', 'check')
    Invoke-Checked npm @('test', '--', '--run')
    Invoke-Checked cargo @('check', '--manifest-path', 'src-tauri/Cargo.toml')
}

Invoke-Checked npm @('run', 'tauri', '--', 'build', '--bundles', 'nsis')
$installer = Get-ChildItem -LiteralPath (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*.exe' |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $installer) { throw 'The NSIS installer was not produced.' }
$digest = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$previousTag = @(git tag --sort=-creatordate | Select-Object -First 1)
$commitRange = if ($previousTag) { "$($previousTag[0])..HEAD" } else { 'HEAD' }
$commits = git log --pretty=format:'- %s (`%h`)' --no-merges $commitRange
if (-not $commits) { $commits = git log -20 --pretty=format:'- %s (`%h`)' --no-merges }
$notes = @"
## Xiao Workbench $Tag

This release combines the upstream SQLite runtime with Xiao's local Codex history, realtime task streaming, usage analytics, performance work, capability editor, unified run controls, verified updater, and Windows startup controls.

### Changes

$($commits -join "`n")

### Windows installer

SHA-256: ``$digest``

The installer is unsigned. Windows may show a SmartScreen warning until a code-signing certificate is introduced.
"@
$notesPath = Join-Path ([IO.Path]::GetTempPath()) "xiao-$($Tag.TrimStart('v'))-release-notes.txt"
[IO.File]::WriteAllText($notesPath, $notes, [Text.UTF8Encoding]::new($false))

if ($PSCmdlet.ShouldProcess("$Repository $Tag", 'Push fork branch and create GitHub release')) {
    Invoke-Checked git @('push', $Remote, 'HEAD')
    Invoke-Checked git @('tag', '-a', $Tag, '-m', "Xiao Workbench $Tag")
    Invoke-Checked git @('push', $Remote, $Tag)
    $arguments = @('release', 'create', $Tag, '--repo', $Repository, '--title', "Xiao Workbench $Tag", '--notes-file', $notesPath, $installer.FullName)
    if ($Draft) { $arguments += '--draft' }
    Invoke-Checked gh $arguments
}

Write-Host "Release ready: $Tag"
Write-Host "Installer: $($installer.FullName)"
Write-Host "SHA-256: $digest"
