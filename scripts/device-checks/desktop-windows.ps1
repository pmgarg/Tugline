# SPEC F9 AC2 [DEVICE]: the Windows UIA sidecar on a real Windows machine.
#   1. the script parses (PowerShell AST);
#   2. it answers ping / list_windows over JSON-RPC;
#   3. the desktop driver computes 7 × 8 = 56 in calc.exe (cua-driver if installed, else the sidecar).
# Usage (from the repo root, in PowerShell): .\scripts\device-checks\desktop-windows.ps1
$ErrorActionPreference = 'Continue'
$pass = 0; $fail = 0
function Ok($m) { Write-Host "PASS  $m"; $script:pass++ }
function Ko($m) { Write-Host "FAIL  $m"; $script:fail++ }
$script = Join-Path $PSScriptRoot '..\..\src\core\automation\desktop\sidecars\windows_uia.ps1'
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$errs) | Out-Null
if ($errs.Count -eq 0) { Ok 'windows_uia.ps1 parses' } else { Ko "parse errors: $($errs | ForEach-Object Message)" }
$out = '{"jsonrpc":"2.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":2,"method":"list_windows"}', '{"jsonrpc":"2.0","id":3,"method":"shutdown"}' | powershell -NoProfile -ExecutionPolicy Bypass -File $script
if ($out -match '"pong":true') { Ok 'sidecar answers ping' } else { Ko "no pong: $out" }
if ($out -match '"windows"') { Ok 'sidecar lists windows' } else { Ko 'no window list' }
node --import tsx scripts/device-checks/desktop-check.mts --backend auto --app calc
if ($LASTEXITCODE -eq 0) { Ok 'calc.exe 7×8=56 through the desktop driver' } else { Ko 'calc.exe check' }
Write-Host "passed $pass, failed $fail"
if ($fail -gt 0) { exit 1 }
