# Posts the five v4-parity bug reports as GitHub issues, forks ParaSwap and KyberSwap,
# and opens the two fix PRs, all as the account `gh` is signed in to.
# Run:  irm https://raw.githubusercontent.com/let-the-dreamers-rise/v4-parity/main/scripts/post-reports.ps1 | iex
# Safe to re-run: issues and PRs that already exist (same title, by you) are skipped.
$ErrorActionPreference = 'Continue'  # native tools write progress to stderr; failures are checked via $LASTEXITCODE
$Raw = 'https://raw.githubusercontent.com/let-the-dreamers-rise/v4-parity/main'
$Me = 'let-the-dreamers-rise'

foreach ($tool in 'gh', 'git') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "Missing '$tool'. Install it with:  winget install --id $(if ($tool -eq 'gh') {'GitHub.cli'} else {'Git.Git'})  then open a new terminal and run this again." -ForegroundColor Red
    return
  }
}
gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Sign in first:  gh auth login   (choose GitHub.com, HTTPS, browser), then run this again." -ForegroundColor Red; return }
gh auth setup-git | Out-Null

$Work = Join-Path $env:TEMP ('v4-parity-post-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $Work | Out-Null
function Fetch($path) { $out = Join-Path $Work ($path -replace '/', '_'); Invoke-WebRequest -UseBasicParsing "$Raw/$path" -OutFile $out; return $out }

$links = [ordered]@{}

# 1. Issues
$issues = Get-Content -Raw -Encoding UTF8 (Fetch 'disclosure/issues.json') | ConvertFrom-Json
foreach ($i in $issues) {
  $existing = gh issue list -R $i.repo --author '@me' --state all --search "$($i.title) in:title" --json url --jq '.[0].url' 2>$null
  if ($existing) { Write-Host "Issue already exists: $existing"; $links[$i.file] = $existing; continue }
  $body = Fetch "disclosure/$($i.file)"
  $url = gh issue create -R $i.repo --title $i.title --body-file $body
  if ($LASTEXITCODE -ne 0) { Write-Host "Could not open the issue on $($i.repo); carrying on." -ForegroundColor Yellow; continue }
  Write-Host "Issue: $url" -ForegroundColor Green
  $links[$i.file] = $url
}

# 2. Forks and fix PRs
$prs = Get-Content -Raw -Encoding UTF8 (Fetch 'disclosure/prs.json') | ConvertFrom-Json
foreach ($p in $prs) {
  $existing = gh pr list -R $p.upstream --author '@me' --state all --head $p.branch --json url --jq '.[0].url' 2>$null
  if ($existing) { Write-Host "PR already exists: $existing"; $links[$p.branch] = $existing; continue }
  gh repo fork $p.upstream --clone=false 2>&1 | Out-Host
  Start-Sleep -Seconds 5
  $dir = Join-Path $Work ($p.branch)
  git clone --filter=blob:none --branch $p.base "https://github.com/$($p.upstream).git" $dir 2>&1 | Out-Host
  Push-Location $dir
  try {
    git remote add fork "https://github.com/$($p.fork).git"
    git checkout -b $p.branch | Out-Null
    git -c user.name='Ashwin Goyal' -c user.email='letthedreamersrise@gmail.com' am (Fetch $p.patch)
    if ($LASTEXITCODE -ne 0) { git am --abort; Write-Host "The patch no longer applies to $($p.upstream) $($p.base); tell the thread." -ForegroundColor Red; continue }
    git push -u fork $p.branch 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Host "Push to $($p.fork) failed." -ForegroundColor Red; continue }
  } finally { Pop-Location }
  $bodyFile = Fetch $p.body
  $issueUrl = $links[$p.issue]
  if ($issueUrl) { (Get-Content -Raw -Encoding UTF8 $bodyFile).Replace('ISSUE_URL', $issueUrl) | Set-Content -Encoding UTF8 $bodyFile }
  $url = gh pr create -R $p.upstream --base $p.base --head "$($Me):$($p.branch)" --title $p.title --body-file $bodyFile
  if ($LASTEXITCODE -ne 0) { Write-Host "Could not open the PR on $($p.upstream)." -ForegroundColor Yellow; continue }
  Write-Host "PR: $url" -ForegroundColor Green
  $links[$p.branch] = $url
}

Write-Host "`nDone. Copy everything below and paste it to Claude in the Uniswap thread:" -ForegroundColor Cyan
$links.GetEnumerator() | ForEach-Object { Write-Host "$($_.Key): $($_.Value)" }
