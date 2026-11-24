/**
 * The PowerShell script that shows the tray icon (see tray.mjs). It's run with -EncodedCommand and
 * gets everything from environment variables, so nothing in it is ever quoted or substituted:
 *
 *   EDJT_TRAY_TITLE       tooltip and notification title
 *   EDJT_TRAY_URL         the dashboard, opened by a left click and "Open Dashboard"
 *   EDJT_TRAY_LOG         the log file for "Show Log" (no menu item when empty)
 *   EDJT_TRAY_ICON        an .ico file; when missing, the icon of EDJT_TRAY_EXE is used
 *   EDJT_TRAY_EXE         the running executable
 *   EDJT_TRAY_PARENT_PID  the app's process: when it's gone, the icon is removed and this exits
 *   EDJT_TRAY_NOTIFY      text for a notification when the icon appears (none when empty)
 *
 * "Quit" writes the line "quit" to stdout for the app to shut down.
 */
export const TRAY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$title = $env:EDJT_TRAY_TITLE
$url = $env:EDJT_TRAY_URL
$parentId = [int]$env:EDJT_TRAY_PARENT_PID

$tray = New-Object System.Windows.Forms.NotifyIcon
if ($env:EDJT_TRAY_ICON -and (Test-Path -LiteralPath $env:EDJT_TRAY_ICON)) {
  $tray.Icon = New-Object System.Drawing.Icon($env:EDJT_TRAY_ICON)
} else {
  $tray.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:EDJT_TRAY_EXE)
}
$tray.Text = $title.Substring(0, [Math]::Min(63, $title.Length))

function Remove-TrayIcon {
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open Dashboard')
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$openItem.add_Click({ Start-Process $url })
if ($env:EDJT_TRAY_LOG) {
  $logItem = $menu.Items.Add('Show Log')
  $logItem.add_Click({
    # A console window following the log; it reads the path from the environment it inherits.
    $command = '$host.UI.RawUI.WindowTitle = $env:EDJT_TRAY_TITLE + '' Log''; Get-Content -LiteralPath $env:EDJT_TRAY_LOG -Encoding UTF8 -Tail 200 -Wait'
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
    Start-Process powershell.exe -ArgumentList @('-NoProfile', '-NoExit', '-EncodedCommand', $encoded)
  })
}
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quitItem = $menu.Items.Add('Quit')
$quitItem.add_Click({
  [Console]::Out.WriteLine('quit')
  [Console]::Out.Flush()
  Remove-TrayIcon
})
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $url } })

# Gone with the app, however it ended.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  try { [void][System.Diagnostics.Process]::GetProcessById($parentId) } catch { Remove-TrayIcon }
})
$timer.Start()

$tray.Visible = $true
if ($env:EDJT_TRAY_NOTIFY) { $tray.ShowBalloonTip(5000, $title, $env:EDJT_TRAY_NOTIFY, [System.Windows.Forms.ToolTipIcon]::Info) }
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run()
`;
