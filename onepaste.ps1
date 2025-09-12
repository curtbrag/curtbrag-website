# ===================== ONE-PASTE: Punctuation + Cachebust + Deploy =====================
$ErrorActionPreference = 'Stop'

# --- Config
$Repo = 'C:\dev\curtbrag-website'
if (-not (Test-Path $Repo)) { throw "Repo not found: $Repo" }
Set-Location $Repo

# --- Helpers
function Need($exe, $hint) {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
    Write-Host "`nERROR: missing $exe" -ForegroundColor Red
    Write-Host $hint
    throw "Install $exe and rerun"
  }
}
Need git     "winget install Git.Git"
Need gh      "winget install GitHub.CLI"
Need netlify "npm i -g netlify-cli   # or winget install Netlify.NetlifyCLI"

try { gh auth status | Out-Null } catch {
  Write-Host "`nLogging in to GitHub..." -ForegroundColor Yellow
  gh auth login -w -s repo -h github.com
}

function EnsureBranch($name){
  $cur = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($cur -eq $name) { return }
  $exists = (git branch --list $name)
  if ($exists) { git switch $name | Out-Null } else { git switch -c $name | Out-Null }
}

function FileText($path){ Get-Content $path -Raw -ErrorAction Stop }
function SaveText($path,$text){ Set-Content -Encoding UTF8 $path $text }

function CommitPushPrMerge($title, $body = "") {
  git add -A
  if (-not (git diff --cached --quiet 2>$null)) {
    git commit -m $title | Out-Null
    git push -u origin HEAD | Out-Null
    gh pr create --title $title --body $body --fill | Out-Null
    gh pr merge --merge --delete-branch -y | Out-Null
  } else {
    Write-Host "No changes to commit for '$title' — skipping PR." -ForegroundColor DarkYellow
  }
}

# --- 1) Punctuation cleanup
$Index = 'index.html'
EnsureBranch 'fix/punct-cleanup'
$txt = FileText $Index

# Replace both common mojibake variants
$txtFixed = $txt
$txtFixed = $txtFixed.Replace('â€™','’').Replace('â€”','—')
$txtFixed = $txtFixed.Replace('Ã¢â‚¬â„¢','’').Replace('Ã¢â‚¬â€','—')

if ($txtFixed -ne $txt) { SaveText $Index $txtFixed }
CommitPushPrMerge "chore(copy): fix mis-encoded punctuation" "Replace mis-encoded apostrophes/dashes."

# --- 2) Cache-bust scoreboard.js (?v=N)
git switch main | Out-Null
git pull        | Out-Null
EnsureBranch 'fix/scoreboard-cachebust'

$txt2   = FileText $Index
$regex  = 'assets/scoreboard\.js(\?v=(\d+))?'
if ($txt2 -match $regex) {
  $bumped = [regex]::Replace($txt2, $regex, {
      param($m)
      $v = 2
      if ($m.Groups[2].Success) { $v = [int]$m.Groups[2].Value + 1 }
      "assets/scoreboard.js?v=$v"
  })
  if ($bumped -ne $txt2) { SaveText $Index $bumped }
}
CommitPushPrMerge "chore: cache-bust scoreboard.js" "Append/increment ?v= to force fresh JS."

# --- 3) Deploy
git switch main | Out-Null
git pull        | Out-Null
Write-Host "`nDeploying to Netlify (prod)..." -ForegroundColor Cyan
netlify deploy --prod

# --- 4) Verify
Write-Host "`nVerify cache-busted script in page:" -ForegroundColor Green
(Invoke-WebRequest "https://curtbrag.com").Content | Select-String 'assets/scoreboard\.js\?v=\d+'

Write-Host "`nFunctions sanity:" -ForegroundColor Green
"SNA     -> " + (Invoke-WebRequest "https://curtbrag.com/.netlify/functions/sna").Content
"Celtics -> " + (Invoke-WebRequest "https://curtbrag.com/.netlify/functions/celtics").Content

Write-Host "`nAll done. If you see a versioned scoreboard.js above and JSON from both functions, you're good." -ForegroundColor Green
# ===================== END ONE-PASTE =====================
