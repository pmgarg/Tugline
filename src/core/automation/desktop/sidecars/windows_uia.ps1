<#
Tugline Windows desktop sidecar (SPEC F9; research CU §2.4, §5.5).

JSON-RPC 2.0 over stdio, one JSON object per line, the same methods as
linux_atspi.py: ping health list_apps list_windows snapshot act set_value
type_text press_key menu scroll pointer screenshot clipboard launch activate
quit shutdown. Exits on stdin EOF.

  tree     UI Automation (System.Windows.Automation, UIA3 via .NET)
  actions  UIA patterns first (Invoke, Toggle, ExpandCollapse, SelectionItem,
           Value): no cursor movement; SendKeys / SendInput for keys and clicks
  pixels   System.Drawing CopyFromScreen of the window rectangle

UIPI: a normal-integrity process cannot drive elevated windows; those calls
return error data {"code":"permission_denied"}.
Element tokens are scoped to the latest snapshot of their window.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OhNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@

$Version = '1.0.0'
$script:Seq = 0
$script:Cache = @{}   # window_id -> @{ snap = n; tokens = @{ token = AutomationElement } }
$AE = [System.Windows.Automation.AutomationElement]
$TW = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function New-RpcError([string]$Message, [string]$Code) {
  $e = [System.Exception]::new($Message)
  $e.Data['code'] = $Code
  return $e
}

function Get-Rect($el) {
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.IsEmpty) { return $null }
    return @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  } catch { return $null }
}

function Get-Windows([string]$App) {
  $out = @()
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $tops = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $tops) {
    try {
      $procId = $w.Current.ProcessId
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      $name = if ($proc) { $proc.ProcessName } else { '' }
      if ($App -and ($name -ne $App) -and ("$procId" -ne $App)) { continue }
      $out += @{
        window_id = "$($w.Current.NativeWindowHandle)"
        pid = $procId
        app = $name
        title = $w.Current.Name
        focused = $w.Current.HasKeyboardFocus
        on_screen = -not $w.Current.IsOffscreen
        minimized = $false
        bounds = (Get-Rect $w)
        _el = $w
      }
    } catch { }
  }
  return $out
}

function Find-Window([string]$Id) {
  foreach ($w in (Get-Windows $null)) { if ($w.window_id -eq $Id) { return $w } }
  throw (New-RpcError "window $Id not found" 'window_target_not_found')
}

function Public($w) {
  $h = @{}
  foreach ($k in $w.Keys) { if (-not $k.StartsWith('_')) { $h[$k] = $w[$k] } }
  return $h
}

function Get-Pattern($el, $pattern) {
  $p = $null
  if ($el.TryGetCurrentPattern($pattern, [ref]$p)) { return $p }
  return $null
}

function Invoke-Snapshot($p) {
  $w = Find-Window $p.window_id
  $script:Seq++
  $snap = $script:Seq
  $tokens = @{}
  $elements = New-Object System.Collections.ArrayList
  $win = $w._el
  $origin = $win.Current.BoundingRectangle
  function Visit($el, $parent, $depth) {
    if ($elements.Count -ge 3000 -or $depth -gt 60) { return }
    $idx = $elements.Count
    $token = "$snap-$idx"
    $tokens[$token] = $el
    $c = $el.Current
    $r = Get-Rect $el
    if ($r) { $r.x -= [int]$origin.X; $r.y -= [int]$origin.Y }
    $item = @{ index = $idx; parent = $parent; role = $c.ControlType.ProgrammaticName; name = $c.Name; description = $c.HelpText; enabled = $c.IsEnabled; focused = $c.HasKeyboardFocus; box = $r; token = $token; actions = @() }
    $vp = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp) { $item.value = $vp.Current.Value; $item.editable = -not $vp.Current.IsReadOnly }
    if ($c.IsPassword) { $item.role = 'PasswordText'; $item.value = $null }
    $tp = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($tp) { $item.checked = ($tp.Current.ToggleState -eq 'On'); $item.actions += 'toggle' }
    $ep = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($ep) { $item.expanded = ($ep.Current.ExpandCollapseState -eq 'Expanded'); $item.actions += 'expand' }
    $sp = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($sp) { $item.selected = $sp.Current.IsSelected; $item.actions += 'select' }
    if (Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)) { $item.actions += 'invoke' }
    [void]$elements.Add($item)
    $child = $TW.GetFirstChild($el)
    while ($child -ne $null) {
      Visit $child $idx ($depth + 1)
      $child = $TW.GetNextSibling($child)
    }
  }
  Visit $win $null 0
  $script:Cache[$p.window_id] = @{ snap = $snap; tokens = $tokens }
  return @{ snapshot_id = "s$snap"; window = (Public $w); elements = $elements; degraded = ($elements.Count -le 1) }
}

function Get-Element($p) {
  $c = $script:Cache[$p.window_id]
  if (-not $c) { throw (New-RpcError "no snapshot of window $($p.window_id) yet" 'stale_element_token') }
  if ($c.tokens.ContainsKey($p.token)) { return $c.tokens[$p.token] }
  if (("$($p.token)".Split('-')[0]) -ne "$($c.snap)") { throw (New-RpcError "stale_element_token: $($p.token) is not from the latest snapshot" 'stale_element_token') }
  throw (New-RpcError "unknown element $($p.token)" 'element_not_found')
}

function Click-At([int]$x, [int]$y, [string]$button = 'left', [int]$count = 1) {
  [void][OhNative]::SetCursorPos($x, $y)
  $down = if ($button -eq 'right') { 0x0008 } else { 0x0002 }
  $up = if ($button -eq 'right') { 0x0010 } else { 0x0004 }
  for ($i = 0; $i -lt $count; $i++) { [OhNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [OhNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero) }
}

function Invoke-Act($p) {
  $el = Get-Element $p
  $a = if ($p.action) { $p.action } else { 'press' }
  try {
    switch ($a) {
      'focus' { $el.SetFocus(); return @{ effect = 'unverifiable'; route = 'uia' } }
      'toggle' { $t = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern); if ($t) { $t.Toggle(); return @{ effect = 'unverifiable'; route = 'uia' } } }
      'expand' { $e = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($e) { if ($e.Current.ExpandCollapseState -eq 'Expanded') { $e.Collapse() } else { $e.Expand() }; return @{ effect = 'unverifiable'; route = 'uia' } } }
      'select' { $s = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($s) { $s.Select(); return @{ effect = 'unverifiable'; route = 'uia' } } }
    }
    if ($a -in @('press', 'click', 'select', 'toggle', 'expand')) {
      $i = Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
      if ($i) { $i.Invoke(); return @{ effect = 'unverifiable'; route = 'uia' } }
    }
  } catch [System.UnauthorizedAccessException] { throw (New-RpcError 'access denied (UIPI: the window runs elevated)' 'permission_denied') }
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty) { throw (New-RpcError 'element has no pattern and no geometry' 'interaction_failed') }
  $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
  if ($a -eq 'right_click') { Click-At $cx $cy 'right' 1 } elseif ($a -eq 'dblclick') { Click-At $cx $cy 'left' 2 } else { Click-At $cx $cy 'left' 1 }
  return @{ effect = 'unverifiable'; route = 'sendinput' }
}

function Invoke-SetValue($p) {
  $el = Get-Element $p
  $v = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
  if (-not $v) { throw (New-RpcError 'element is not settable' 'not_settable') }
  $v.SetValue([string]$p.value)
  return @{ effect = 'unverifiable'; route = 'uia' }
}

function ConvertTo-SendKeys([string]$spec) {
  $map = @{ enter = '{ENTER}'; return = '{ENTER}'; esc = '{ESC}'; escape = '{ESC}'; tab = '{TAB}'; backspace = '{BACKSPACE}'; delete = '{DELETE}'; up = '{UP}'; down = '{DOWN}'; left = '{LEFT}'; right = '{RIGHT}'; home = '{HOME}'; end = '{END}'; space = ' ' }
  $mods = @{ ctrl = '^'; control = '^'; alt = '%'; shift = '+'; cmd = '^'; win = '^' }
  $out = ''
  foreach ($chord in ($spec -split ' ')) {
    if (-not $chord) { continue }
    $parts = $chord -split '\+'
    $prefix = ''
    for ($i = 0; $i -lt $parts.Length - 1; $i++) { $prefix += $mods[$parts[$i].ToLower()] }
    $k = $parts[-1]
    $key = if ($map.ContainsKey($k.ToLower())) { $map[$k.ToLower()] } elseif ($k.Length -eq 1) { $k.ToLower() } else { "{$($k.ToUpper())}" }
    $out += "$prefix$key"
  }
  return $out
}

function Focus-Window($id) {
  if (-not $id) { return }
  try { [void][OhNative]::SetForegroundWindow([IntPtr][int64]$id) } catch { }
}

function Invoke-TypeText($p) {
  if ($p.token) { (Get-Element $p).SetFocus() } else { Focus-Window $p.window_id }
  $escaped = ([string]$p.text) -replace '([+^%~(){}\[\]])', '{$1}'
  [System.Windows.Forms.SendKeys]::SendWait($escaped)
  return @{ effect = 'unverifiable'; route = 'sendkeys' }
}

function Invoke-PressKey($p) {
  Focus-Window $p.window_id
  [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeys ([string]$p.keys)))
  return @{ effect = 'unverifiable'; route = 'sendkeys' }
}

function Invoke-Menu($p) {
  $w = (Get-Windows $p.app) | Select-Object -First 1
  if (-not $w) { throw (New-RpcError "no window for app $($p.app)" 'not_found') }
  $node = $w._el
  foreach ($label in $p.path) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $label)
    $item = $node.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if (-not $item) { $item = $AE::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) }
    if (-not $item) { throw (New-RpcError "no menu item $label" 'not_found') }
    $e = Get-Pattern $item ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($e) { $e.Expand() } else { $i = Get-Pattern $item ([System.Windows.Automation.InvokePattern]::Pattern); if ($i) { $i.Invoke() } }
    Start-Sleep -Milliseconds 150
    $node = $item
  }
  return @{ effect = 'unverifiable'; route = 'uia' }
}

function Invoke-Scroll($p) {
  $w = Find-Window $p.window_id
  $target = if ($p.token) { Get-Element $p } else { $w._el }
  $s = Get-Pattern $target ([System.Windows.Automation.ScrollPattern]::Pattern)
  $n = if ($p.amount) { [int]$p.amount } else { 3 }
  if ($s) {
    for ($i = 0; $i -lt $n; $i++) {
      switch ($p.direction) {
        'up' { $s.ScrollVertical('SmallDecrement') } 'down' { $s.ScrollVertical('SmallIncrement') }
        'left' { $s.ScrollHorizontal('SmallDecrement') } 'right' { $s.ScrollHorizontal('SmallIncrement') }
      }
    }
    return @{ effect = 'unverifiable'; route = 'uia' }
  }
  throw (New-RpcError 'element is not scrollable' 'unsupported')
}

function Invoke-Pointer($p) {
  $w = Find-Window $p.window_id
  $b = $w.bounds
  $x = [int]($b.x + $p.x); $y = [int]($b.y + $p.y)
  switch ($p.action) {
    'right_click' { Click-At $x $y 'right' 1 }
    'dblclick' { Click-At $x $y 'left' 2 }
    default { Click-At $x $y 'left' 1 }
  }
  return @{ effect = 'unverifiable'; route = 'sendinput' }
}

function Invoke-Screenshot($p) {
  if ($p.window_id) { $b = (Find-Window $p.window_id).bounds } else { $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b = @{ x = $s.X; y = $s.Y; width = $s.Width; height = $s.Height } }
  $bmp = New-Object System.Drawing.Bitmap ([int]$b.width), ([int]$b.height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$b.x, [int]$b.y, 0, 0, $bmp.Size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return @{ png_base64 = [Convert]::ToBase64String($ms.ToArray()); scale = 1 }
}

function Invoke-Clipboard($p) {
  if ($p.op -eq 'write') { Set-Clipboard -Value ([string]$p.text); return @{} }
  return @{ text = (Get-Clipboard -Raw) }
}

function Invoke-Launch($p) {
  $env:QT_ACCESSIBILITY = '1'
  $proc = Start-Process -FilePath $p.app -ArgumentList @($p.args) -PassThru
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    if ((Get-Windows $null) | Where-Object { $_.pid -eq $proc.Id }) { return @{ effect = 'confirmed'; pid = $proc.Id } }
    Start-Sleep -Milliseconds 200
  }
  return @{ effect = 'unverifiable'; pid = $proc.Id; summary = 'launched, but no window appeared yet' }
}

function Resolve-Pid($p) {
  if ($p.pid) { return [int]$p.pid }
  if ($p.window_id) { return (Find-Window $p.window_id).pid }
  $proc = Get-Process -Name $p.app -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc) { return $proc.Id }
  return $null
}

function Invoke-Activate($p) {
  $id = $p.window_id
  if (-not $id) { $w = (Get-Windows $p.app) | Select-Object -First 1; if ($w) { $id = $w.window_id } }
  if (-not $id) { return @{ effect = 'unverifiable'; summary = 'no window to activate' } }
  Focus-Window $id
  return @{ effect = 'confirmed'; route = 'SetForegroundWindow' }
}

function Invoke-Quit($p) {
  $procId = Resolve-Pid $p
  if (-not $procId) { throw (New-RpcError 'app is not running' 'not_found') }
  Stop-Process -Id $procId
  return @{ effect = 'confirmed' }
}

function Invoke-Health($p) {
  return @{ ok = $true; version = $Version; platform = 'win32'; permissions = @{ accessibility = $true }; message = 'UIA via System.Windows.Automation' }
}

$Methods = @{
  'ping' = { param($p) @{ pong = $true; version = $Version; backend = 'windows-uia' } }
  'health' = { param($p) Invoke-Health $p }
  'list_apps' = { param($p) @{ apps = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { @{ name = $_.ProcessName; pid = $_.Id; path = $_.Path; running = $true } }) } }
  'list_windows' = { param($p) @{ windows = @((Get-Windows $p.app) | ForEach-Object { Public $_ }) } }
  'snapshot' = { param($p) Invoke-Snapshot $p }
  'act' = { param($p) Invoke-Act $p }
  'set_value' = { param($p) Invoke-SetValue $p }
  'type_text' = { param($p) Invoke-TypeText $p }
  'press_key' = { param($p) Invoke-PressKey $p }
  'menu' = { param($p) Invoke-Menu $p }
  'scroll' = { param($p) Invoke-Scroll $p }
  'pointer' = { param($p) Invoke-Pointer $p }
  'screenshot' = { param($p) Invoke-Screenshot $p }
  'clipboard' = { param($p) Invoke-Clipboard $p }
  'launch' = { param($p) Invoke-Launch $p }
  'activate' = { param($p) Invoke-Activate $p }
  'quit' = { param($p) Invoke-Quit $p }
}

function Send-Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 20 -Compress))
  [Console]::Out.Flush()
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }   # stdin EOF: the harness is gone
  if (-not $line.Trim()) { continue }
  try { $req = $line | ConvertFrom-Json } catch { Send-Reply @{ jsonrpc = '2.0'; id = $null; error = @{ code = -32700; message = 'parse error' } }; continue }
  if ($req.method -eq 'shutdown') { Send-Reply @{ jsonrpc = '2.0'; id = $req.id; result = @{ ok = $true } }; break }
  $fn = $Methods[$req.method]
  if (-not $fn) { Send-Reply @{ jsonrpc = '2.0'; id = $req.id; error = @{ code = -32601; message = "unknown method $($req.method)" } }; continue }
  try {
    $params = if ($req.params) { $req.params } else { @{} }
    Send-Reply @{ jsonrpc = '2.0'; id = $req.id; result = (& $fn $params) }
  } catch {
    $code = $_.Exception.Data['code']
    Send-Reply @{ jsonrpc = '2.0'; id = $req.id; error = @{ code = -32000; message = $_.Exception.Message; data = @{ code = $code } } }
  }
}
