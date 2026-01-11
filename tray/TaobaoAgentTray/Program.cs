using System.Diagnostics;
using System.Drawing;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

namespace TaobaoAgentTray;

internal static class Program
{
  [STAThread]
  private static void Main()
  {
    using var mutex = new Mutex(initiallyOwned: true, name: @"Local\TaobaoAgentTray", createdNew: out var createdNew);
    if (!createdNew) return;

    Application.SetHighDpiMode(HighDpiMode.SystemAware);
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new TrayAppContext());
  }
}

internal sealed class TrayAppContext : ApplicationContext
{
  private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromMilliseconds(800) };
  private readonly NotifyIcon tray = new();
  private readonly System.Windows.Forms.Timer timer = new();
  private readonly SemaphoreSlim pollLock = new(1, 1);

  private readonly Icon iconRed;
  private readonly Icon iconYellow;
  private readonly Icon iconGreen;

  private bool autoStartAttempted;
  private bool autoOpenPairingAttempted;
  private StatusSnapshot? last;
  private int lastPort = 17880;

  public TrayAppContext()
  {
    iconRed = LoadEmbeddedIcon("TaobaoAgentTray.Resources.tray-red.ico");
    iconYellow = LoadEmbeddedIcon("TaobaoAgentTray.Resources.tray-yellow.ico");
    iconGreen = LoadEmbeddedIcon("TaobaoAgentTray.Resources.tray-green.ico");

    var menu = new ContextMenuStrip();
    menu.Items.Add("打开状态页", null, (_, _) => OpenStatusPage());
    menu.Items.Add("启动/重启 Agent", null, (_, _) => RunCommand("start-agent.cmd"));
    menu.Items.Add("打开后台", null, (_, _) => OpenAdmin());
    menu.Items.Add("复制 AgentId", null, (_, _) => CopyAgentId());
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("退出", null, (_, _) => ExitApp());

    tray.ContextMenuStrip = menu;
    tray.Icon = iconRed;
    tray.Text = SafeTooltip("Agent未启动");
    tray.Visible = true;
    tray.DoubleClick += (_, _) => OpenStatusPage();

    timer.Interval = 2000;
    timer.Tick += async (_, _) => await PollOnce().ConfigureAwait(true);
    timer.Start();

    AutoStartAgentOnce();
    _ = PollOnce();
  }

  protected override void Dispose(bool disposing)
  {
    if (disposing)
    {
      timer.Stop();
      timer.Dispose();
      tray.Visible = false;
      tray.Dispose();
      httpClient.Dispose();
      pollLock.Dispose();
      iconRed.Dispose();
      iconYellow.Dispose();
      iconGreen.Dispose();
    }
    base.Dispose(disposing);
  }

  private async Task PollOnce()
  {
    if (!await pollLock.WaitAsync(0).ConfigureAwait(true)) return;
    try
    {
      var found = await TryGetStatus(lastPort).ConfigureAwait(true);
      if (found == null)
      {
        for (var p = 17880; p <= 17890; p++)
        {
          if (p == lastPort) continue;
          found = await TryGetStatus(p).ConfigureAwait(true);
          if (found != null)
          {
            lastPort = p;
            break;
          }
        }
      }

      last = found;
      UpdateUi(found);
    }
    finally
    {
      pollLock.Release();
    }
  }

  private void AutoStartAgentOnce()
  {
    if (autoStartAttempted) return;
    autoStartAttempted = true;
    RunCommand("start-agent.cmd");
  }

  private async Task<StatusSnapshot?> TryGetStatus(int port)
  {
    try
    {
      using var res = await httpClient.GetAsync($"http://127.0.0.1:{port}/api/status").ConfigureAwait(true);
      if (!res.IsSuccessStatusCode) return null;

      var json = await res.Content.ReadAsStringAsync().ConfigureAwait(true);
      using var doc = JsonDocument.Parse(json);
      var root = doc.RootElement;
      if (root.ValueKind != JsonValueKind.Object) return null;

      var payload = root;
      if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
      {
        payload = data;
      }

      var connected = payload.TryGetProperty("connected", out var c) && c.ValueKind == JsonValueKind.True;
      var hasToken = payload.TryGetProperty("hasToken", out var t) && t.ValueKind == JsonValueKind.True;
      var agentId = payload.TryGetProperty("agentId", out var a) && a.ValueKind == JsonValueKind.String ? a.GetString() ?? "" : "";
      var adminUrl = payload.TryGetProperty("adminUrl", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "";

      return new StatusSnapshot(port, connected, hasToken, agentId, adminUrl);
    }
    catch
    {
      return null;
    }
  }

  private void UpdateUi(StatusSnapshot? status)
  {
    if (status == null)
    {
      tray.Icon = iconRed;
      tray.Text = SafeTooltip("Agent未启动");
      SetMenuEnabled(hasStatus: false);
      return;
    }

    SetMenuEnabled(hasStatus: true);

    if (!status.HasToken)
    {
      tray.Icon = iconRed;
      tray.Text = SafeTooltip("未配对");
      MaybeAutoOpenPairingPage(status);
      return;
    }

    if (!status.Connected)
    {
      tray.Icon = iconYellow;
      tray.Text = SafeTooltip("未连接");
      return;
    }

    tray.Icon = iconGreen;
    tray.Text = SafeTooltip("已连接");
  }

  private void MaybeAutoOpenPairingPage(StatusSnapshot status)
  {
    if (autoOpenPairingAttempted) return;
    autoOpenPairingAttempted = true;

    try
    {
      tray.ShowBalloonTip(2000, "Taobao Agent", "请在打开的页面输入授权码完成配对。", ToolTipIcon.Info);
    }
    catch { }

    OpenUrl($"http://127.0.0.1:{status.Port}/");
  }

  private void SetMenuEnabled(bool hasStatus)
  {
    if (tray.ContextMenuStrip == null) return;
    foreach (ToolStripItem item in tray.ContextMenuStrip.Items)
    {
      if (item is ToolStripMenuItem mi)
      {
        if (mi.Text == "打开后台") mi.Enabled = hasStatus && !string.IsNullOrWhiteSpace(last?.AdminUrl);
        if (mi.Text == "复制 AgentId") mi.Enabled = hasStatus && !string.IsNullOrWhiteSpace(last?.AgentId);
      }
    }
  }

  private void OpenStatusPage()
  {
    if (last != null)
    {
      OpenUrl($"http://127.0.0.1:{last.Port}/");
      return;
    }
    RunCommand("open-status.cmd");
  }

  private void OpenAdmin()
  {
    var url = last?.AdminUrl?.Trim() ?? "";
    if (string.IsNullOrWhiteSpace(url))
    {
      tray.ShowBalloonTip(1500, "Taobao Agent", "未获取到后台地址，请先打开状态页。", ToolTipIcon.Info);
      return;
    }
    OpenUrl(url);
  }

  private void CopyAgentId()
  {
    var id = last?.AgentId?.Trim() ?? "";
    if (string.IsNullOrWhiteSpace(id))
    {
      tray.ShowBalloonTip(1500, "Taobao Agent", "未获取到 AgentId。", ToolTipIcon.Info);
      return;
    }
    try
    {
      Clipboard.SetText(id);
      tray.ShowBalloonTip(1500, "Taobao Agent", "已复制 AgentId。", ToolTipIcon.Info);
    }
    catch
    {
      tray.ShowBalloonTip(1500, "Taobao Agent", "复制失败。", ToolTipIcon.Error);
    }
  }

  private void ExitApp()
  {
    tray.Visible = false;
    ExitThread();
  }

  private static string SafeTooltip(string text)
  {
    var t = (text ?? "").Trim();
    return t.Length <= 60 ? t : t[..60];
  }

  private static void RunCommand(string fileName)
  {
    try
    {
      var path = Path.Combine(AppContext.BaseDirectory, fileName);
      if (!File.Exists(path)) return;
      if (OperatingSystem.IsWindows())
      {
        Process.Start(
          new ProcessStartInfo
          {
            FileName = "cmd.exe",
            Arguments = $"/c \"\"{path}\"\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = AppContext.BaseDirectory,
          }
        );
        return;
      }

      Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true, WorkingDirectory = AppContext.BaseDirectory });
    }
    catch { }
  }

  private static void OpenUrl(string url)
  {
    if (string.IsNullOrWhiteSpace(url)) return;
    try
    {
      Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }
    catch { }
  }

  private static Icon LoadEmbeddedIcon(string resourceName)
  {
    var assembly = Assembly.GetExecutingAssembly();
    using var stream = assembly.GetManifestResourceStream(resourceName);
    if (stream != null)
    {
      return new Icon(stream);
    }
    return SystemIcons.Application;
  }

  private sealed record StatusSnapshot(int Port, bool Connected, bool HasToken, string AgentId, string AdminUrl);
}
