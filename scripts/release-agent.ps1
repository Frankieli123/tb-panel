param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,

  [switch]$AutoCommit,

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

Assert-Tool git
Assert-Tool node
Assert-Tool npm

$repoRoot = Get-RepoRoot
$tag = Normalize-Tag $Tag
$version = Get-VersionFromTag $tag

Set-Location $repoRoot

$dirty = ([string](git status --porcelain)).Trim()
if ($dirty) {
  if (-not $AutoCommit) {
    Write-Host '>> Working tree is dirty:' -ForegroundColor Yellow
    git status -uall
    throw 'Working tree is dirty. Commit/stash (or pass -AutoCommit) before releasing.'
  }

  $msg = ([string]$AutoCommitMessage).Trim()
  if (-not $msg) { $msg = "chore: prepare release $tag" }

  Write-Host ">> Auto-commit all changes: $msg" -ForegroundColor Yellow
  Invoke-Native git @('add', '-A')
  Invoke-Native git @('commit', '-m', $msg)
}

$currentBranch = ([string](git rev-parse --abbrev-ref HEAD)).Trim()
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

$currentVersion = ([string](node -p "require('./server/package.json').version")).Trim()
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

  $staged = ([string](git diff --cached --name-only)).Trim()
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
