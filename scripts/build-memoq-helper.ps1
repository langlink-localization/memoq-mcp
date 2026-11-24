$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$csproj = Join-Path $repoRoot "native\memoq-bridge-helper\MemoQ.Bridge.Helper.csproj"
$buildOut = Join-Path $repoRoot "native\memoq-bridge-helper\bin\Release\net48\MemoQ.Bridge.Helper.exe"
$targetDir = Join-Path $repoRoot "packages\memoq-bridge\bin"
$targetExe = Join-Path $targetDir "MemoQ.Bridge.Helper.exe"

Write-Host "Building MemoQ.Bridge.Helper (net48, Release)..."
& dotnet build -c Release $csproj
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $buildOut -PathType Leaf)) {
  throw "Expected helper executable was not built: $buildOut"
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $buildOut -Destination $targetExe -Force
Write-Host "Copied $targetExe ($((Get-Item $targetExe).Length) bytes)"
