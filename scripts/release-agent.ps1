param(
  [Parameter(Mandatory = $true)]
  [Alias('Version')]
  [string]$Tag,

  [switch]$AutoCommit,

  [switch]$ForceUnsafeAutoCommit,

  [switch]$RequireClean,

  [ValidateRange(1, 2048)]
  [int]$MaxAutoCommitFileMB = 50,

  [string]$AutoCommitMessage = '',

  [string]$Remote = 'origin',

  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  if (-not $PSScriptRoot) {
    throw 'Cannot determine script directory ($PSScriptRoot is empty)'
  }
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Assert-Tool($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required tool: $name"
  }
}

function Normalize-Tag([string]$value) {
  $v = ([string]$value).Trim()
  if (-not $v) { throw 'Tag is required' }
  if ($v -notmatch '^(v)?\d+\.\d+\.\d+$') {
    throw "Invalid tag: $v (expected vX.Y.Z or X.Y.Z)"
  }
  if ($v -notmatch '^v') { $v = "v$v" }
  return $v
}

function Get-VersionFromTag([string]$tag) {
  return ($tag -replace '^v', '')
}

function Invoke-Native([string]$file, [string[]]$arguments) {
  & $file @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed (exit=$LASTEXITCODE): $file $($arguments -join ' ')"
  }
}

function Get-DirtyPaths([string[]]$porcelainLines) {
  $dirtyPaths = @()
  foreach ($line in $porcelainLines) {
    $l = ([string]$line).TrimEnd("`r")
    if (-not $l) { continue }
    if ($l.Length -lt 3) { continue }

    # git status --porcelain: "XY <path>" or "?? <path>"
    $p = if ($l.Length -ge 4) { $l.Substring(3) } else { '' }
    if ($p -like '* -> *') { $p = ($p -split ' -> ' | Select-Object -Last 1) }
    $p = ([string]$p).Trim()
    if ($p) { $dirtyPaths += $p }
  }
  return @($dirtyPaths | Select-Object -Unique)
}

function Get-UnsafeDirtyPaths([string[]]$dirtyPaths, [int]$maxFileMB) {
  $unsafe = @()
  $maxBytes = [int64]$maxFileMB * 1024 * 1024

  foreach ($p in $dirtyPaths) {
    $path = ([string]$p).Trim()
    if (-not $path) { continue }

    $norm = $path -replace '\\', '/'
    if ($norm -match '^(release|releases)(/|\\)') { $unsafe += $path; continue }
    if ($norm -match '^release\d+(/|\\)') { $unsafe += $path; continue }

    $extRaw = [System.IO.Path]::GetExtension($path)
    $ext = if ($extRaw) { $extRaw.ToLowerInvariant() } else { '' }
    if ($ext -in @('.zip', '.7z', '.rar', '.msi', '.exe', '.dll', '.pdb')) { $unsafe += $path; continue }

    if (Test-Path -LiteralPath $path) {
      try {
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($item -and -not $item.PSIsContainer -and ($item.Length -gt $maxBytes)) {
          $unsafe += $path
          continue
        }
      } catch {}
    }
  }

  return @($unsafe | Select-Object -Unique)
}

Assert-Tool git
Assert-Tool node
Assert-Tool npm

$repoRoot = Get-RepoRoot
$tag = Normalize-Tag $Tag
$version = Get-VersionFromTag $tag

Set-Location $repoRoot

$dirtyLines = @(git status --porcelain)
$dirty = ($dirtyLines -join "`n")
if ($dirtyLines.Count -gt 0) {
  if ($RequireClean) {
    Write-Host '>> Working tree is dirty:' -ForegroundColor Yellow
    git status -uall
    throw 'Working tree is dirty. Commit/stash first, or re-run without -RequireClean.'
  }

  if (-not $AutoCommit) {
    # Default behavior: auto-commit normal source changes (one-click release),
    # but refuse to auto-commit large artifacts / release bundles (they break GitHub push limits).
    $dirtyPaths = Get-DirtyPaths $dirtyLines
    $unsafe = Get-UnsafeDirtyPaths $dirtyPaths $MaxAutoCommitFileMB
    if ($unsafe.Count -gt 0 -and -not $ForceUnsafeAutoCommit) {
      Write-Host '>> Working tree is dirty:' -ForegroundColor Yellow
      git status -uall
      throw "Working tree has unsafe changes for auto-commit. Remove these files (or add to .gitignore), or pass -ForceUnsafeAutoCommit. Files: $($unsafe -join ', ')"
    }

    Write-Host '>> Working tree is dirty: auto-committing changes' -ForegroundColor Yellow
    $AutoCommit = $true
  }

  $msg = ([string]$AutoCommitMessage).Trim()
  if (-not $msg) { $msg = "chore: prepare release $tag" }

  Write-Host ">> Auto-commit all changes: $msg" -ForegroundColor Yellow
  Invoke-Native git @('add', '-A')
  Invoke-Native git @('commit', '-m', $msg)
}

$currentBranch = (@(git branch --show-current) -join "`n").Trim()
if ($currentBranch -ne $Branch) {
  throw "You are on branch '$currentBranch'. Please checkout '$Branch' before releasing."
}

Write-Host ">> Sync: git pull --rebase $Remote $Branch"
Invoke-Native git @('pull', '--rebase', $Remote, $Branch)

Write-Host ">> Fetch tags: git fetch $Remote --tags"
Invoke-Native git @('fetch', $Remote, '--tags')

if ((git rev-parse -q --verify "refs/tags/$tag" 2>$null)) {
  throw "Tag already exists: $tag"
}

$pkgPath = Join-Path $repoRoot 'server/package.json'
if (-not (Test-Path $pkgPath)) {
  throw "Missing: $pkgPath"
}

$currentVersion = (@(node -p "require('./server/package.json').version") -join "`n").Trim()
if (-not $currentVersion) { throw 'Cannot read server/package.json version' }

if ($currentVersion -ne $version) {
  Write-Host ">> Set version: $currentVersion -> $version"
  Push-Location (Join-Path $repoRoot 'server')
  try {
    Invoke-Native npm @('version', $version, '--no-git-tag-version')
  } finally {
    Pop-Location
  }

  Invoke-Native git @('add', 'server/package.json', 'server/package-lock.json')

  $staged = (@(git diff --cached --name-only) -join "`n").Trim()
  if ($staged) {
    Invoke-Native git @('commit', '-m', "chore(agent): release $tag")
  }
}

Write-Host ">> Create tag: $tag"
Invoke-Native git @('tag', '-a', $tag, '-m', $tag)

Write-Host ">> Push: $Remote $Branch + $tag"
Invoke-Native git @('push', $Remote, $Branch)
Invoke-Native git @('push', $Remote, $tag)

Write-Host 'OK'
Write-Host "  Tag:     $tag"
Write-Host '  Next:    GitHub Actions -> Release Agent'
