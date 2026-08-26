<#
  Vesper tray helper.

  Owns a WinForms NotifyIcon and speaks one JSON object per line with the Vesper host:

    in : {"type":"menu","items":[{"id","label","enabled","role"}]}
         {"type":"tip","text":"..."}
         {"type":"exit"}
    out: {"type":"ready"} {"type":"click","id":"..."} {"type":"error","message":"..."}

  stdin is read on a background runspace and drained by a UI-thread timer, because the
  WinForms message pump must own the main thread for the icon to respond at all.

  STATUS: implemented, NOT validated on hardware. No Windows machine was available.
#>
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-TrayEvent($payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

$queue = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))

$runspace = [RunspaceFactory]::CreateRunspace()
$runspace.Open()
$runspace.SessionStateProxy.SetVariable('queue', $queue)
$reader = [PowerShell]::Create()
$reader.Runspace = $runspace
[void]$reader.AddScript({
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { $queue.Enqueue('{"type":"__eof"}'); break }
    $queue.Enqueue($line)
  }
})
[void]$reader.BeginInvoke()

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = 'Vesper'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$icon.ContextMenuStrip = $menu
$icon.Visible = $true

$context = New-Object System.Windows.Forms.ApplicationContext

function Set-TrayMenu($items) {
  $menu.Items.Clear()
  foreach ($item in $items) {
    if ($item.role -eq 'separator') {
      [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
      continue
    }
    $entry = New-Object System.Windows.Forms.ToolStripMenuItem
    $entry.Text = [string]$item.label
    $entry.Enabled = [bool]$item.enabled
    # The id lives on the control, not in a closure: a closure would capture the last
    # loop variable and every menu entry would report the same id.
    $entry.Tag = [string]$item.id
    $entry.Add_Click({ Write-TrayEvent @{ type = 'click'; id = $this.Tag } })
    [void]$menu.Items.Add($entry)
  }
}

$shutdown = {
  $timer.Stop()
  $icon.Visible = $false
  $context.ExitThread()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  while ($queue.Count -gt 0) {
    $line = $queue.Dequeue()
    try { $message = $line | ConvertFrom-Json } catch { continue }
    switch ($message.type) {
      'menu'  { Set-TrayMenu $message.items }
      'tip'   { $icon.Text = [string]$message.text }
      'exit'  { & $shutdown }
      '__eof' { & $shutdown }
    }
  }
})
$timer.Start()

Write-TrayEvent @{ type = 'ready' }
try {
  [System.Windows.Forms.Application]::Run($context)
} catch {
  Write-TrayEvent @{ type = 'error'; message = $_.Exception.Message }
} finally {
  $icon.Visible = $false
  $icon.Dispose()
  $reader.Dispose()
  $runspace.Dispose()
}
