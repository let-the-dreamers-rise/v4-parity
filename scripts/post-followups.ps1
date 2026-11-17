# Posts the four 17 Nov 2026 follow-up comments (ParaSwap, KyberSwap, Rust v4 SDK, Tycho)
# as the account `gh` is signed in to. Safe to re-run: a comment you already posted is skipped.
# Run from cmd:  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/let-the-dreamers-rise/v4-parity/main/scripts/post-followups.ps1 | iex"
$ErrorActionPreference = 'Continue'
$Raw = 'https://raw.githubusercontent.com/let-the-dreamers-rise/v4-parity/main/disclosure/followups'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Write-Host "Missing 'gh'. Install: winget install --id GitHub.cli, open a new terminal, run again." -ForegroundColor Red; return }
gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Sign in first: gh auth login, then run this again." -ForegroundColor Red; return }
$me = gh api user --jq .login
$work = Join-Path $env:TEMP ('v4p-followups-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $work | Out-Null
$list = (Invoke-WebRequest -UseBasicParsing "$Raw/followups.json").Content | ConvertFrom-Json
$done = @()
foreach ($c in $list) {
  $file = Join-Path $work $c.file
  Invoke-WebRequest -UseBasicParsing "$Raw/$($c.file)" -OutFile $file
  $first = (Get-Content -Encoding UTF8 $file | Select-Object -First 1).Substring(0, 40)
  $already = gh api "repos/$($c.repo)/issues/$($c.number)/comments" --paginate --jq ".[] | select(.user.login==`"$me`") | .body" 2>$null | Select-String -SimpleMatch $first
  if ($already) { Write-Host "Already posted on $($c.repo)#$($c.number), skipping."; continue }
  if ($c.kind -eq 'pr') { $url = gh pr comment $c.number -R $c.repo --body-file $file } else { $url = gh issue comment $c.number -R $c.repo --body-file $file }
  if ($LASTEXITCODE -ne 0) { Write-Host "Could not comment on $($c.repo)#$($c.number); carrying on." -ForegroundColor Yellow; continue }
  Write-Host "Posted: $url" -ForegroundColor Green
  $done += $url
}
Write-Host "`nDone. Paste this to Claude in the Uniswap thread:" -ForegroundColor Cyan
$done | ForEach-Object { Write-Host $_ }
