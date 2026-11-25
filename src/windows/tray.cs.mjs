/**
 * The tray icon program (see tray.mjs), compiled once with the C# compiler that comes with .NET
 * Framework 4 on every Windows 10 and 11. It's a program of its own so that Windows lists the icon
 * (in Settings, and on its notifications) as "ED Journal Tool" rather than as the program showing
 * it. It reads everything from the same environment variables as tray.ps1.mjs, and writes "ready"
 * and "quit" to stdout in the same way.
 *
 * C# 5: no string interpolation or ?. (that's the compiler .NET Framework has).
 */
export const TRAY_PROGRAM = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("ED Journal Tool")]
[assembly: AssemblyProduct("ED Journal Tool")]
[assembly: AssemblyDescription("ED Journal Tool tray icon")]

static class EdjtTray {
  static NotifyIcon tray;

  static string Setting(string name) {
    return Environment.GetEnvironmentVariable(name) ?? "";
  }

  static void Say(string line) {
    Console.Out.WriteLine(line);
    Console.Out.Flush();
  }

  static void OpenDashboard() {
    try { Process.Start(Setting("EDJT_TRAY_URL")); } catch (Exception) { }
  }

  static void ShowLog() {
    // A console window following the log; it reads the path from the environment it inherits.
    // Passed as plain text, not -EncodedCommand (which antivirus treats as suspicious): it has no
    // double quotes, so wrapped in them it arrives as one argument, and nothing in it is substituted.
    string command = "$host.UI.RawUI.WindowTitle = $env:EDJT_TRAY_TITLE + ' Log'; Get-Content -LiteralPath $env:EDJT_TRAY_LOG -Encoding UTF8 -Tail 200 -Wait";
    try { Process.Start("powershell.exe", "-NoProfile -NoExit -Command \"" + command + "\""); } catch (Exception) { }
  }

  static void RemoveIcon() {
    tray.Visible = false;
    tray.Dispose();
    Application.Exit();
  }

  [STAThread]
  static void Main() {
    Application.EnableVisualStyles();
    string title = Setting("EDJT_TRAY_TITLE");
    string iconPath = Setting("EDJT_TRAY_ICON");
    int parentId = int.Parse(Setting("EDJT_TRAY_PARENT_PID"));

    tray = new NotifyIcon();
    tray.Icon = iconPath.Length > 0 && File.Exists(iconPath)
      ? new Icon(iconPath)
      : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    tray.Text = title.Length > 63 ? title.Substring(0, 63) : title;

    ContextMenuStrip menu = new ContextMenuStrip();
    ToolStripItem openItem = menu.Items.Add("Open Dashboard");
    openItem.Font = new Font(openItem.Font, FontStyle.Bold);
    openItem.Click += delegate { OpenDashboard(); };
    if (Setting("EDJT_TRAY_LOG").Length > 0) {
      menu.Items.Add("Show Log").Click += delegate { ShowLog(); };
    }
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Quit").Click += delegate {
      Say("quit");
      RemoveIcon();
    };
    tray.ContextMenuStrip = menu;
    tray.MouseClick += delegate(object sender, MouseEventArgs e) {
      if (e.Button == MouseButtons.Left) OpenDashboard();
    };

    // Gone with the app, however it ended.
    Timer timer = new Timer();
    timer.Interval = 1000;
    timer.Tick += delegate {
      try {
        if (Process.GetProcessById(parentId).HasExited) RemoveIcon();
      } catch (Exception) {
        RemoveIcon();
      }
    };
    timer.Start();

    tray.Visible = true;
    string notification = Setting("EDJT_TRAY_NOTIFY");
    if (notification.Length > 0) tray.ShowBalloonTip(5000, title, notification, ToolTipIcon.Info);
    Say("ready");
    Application.Run();
  }
}
`;
