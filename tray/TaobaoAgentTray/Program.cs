using System.Diagnostics;
using System.Drawing;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

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
  private readonly SemaphoreSlim updateLock = new(1, 1);
  private readonly Dictionary<string, string> envFile;
  private readonly string versionTag;
  private readonly SynchronizationContext uiContext;

  private readonly Icon iconRed;
  private readonly Icon iconYellow;
  private readonly Icon iconGreen;

  private bool autoStartAttempted;
  private bool autoOpenPairingAttempted;
  private StatusSnapshot? last;
  private int lastPort = 17880;
  private DateTime nextUpdateCheckUtc = DateTime.UtcNow.AddMinutes(2);

  public TrayAppContext()
  {
    uiContext = SynchronizationContext.Current ?? new SynchronizationContext();
    envFile = LoadEnvFile(Path.Combine(AppContext.BaseDirectory, ".env"));
    var current = ReadCurrentVersion(AppContext.BaseDirectory);
    versionTag = current != null ? $"v{current}" : "";

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
      MaybeStartSilentUpdate(found);
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
    var suffix = string.IsNullOrWhiteSpace(versionTag) ? "" : $" {versionTag}";
    if (status == null)
    {
      tray.Icon = iconRed;
      tray.Text = SafeTooltip("Agent未启动" + suffix);
      SetMenuEnabled(hasStatus: false);
      return;
    }

    SetMenuEnabled(hasStatus: true);

    if (!status.HasToken)
    {
      tray.Icon = iconRed;
      tray.Text = SafeTooltip("未配对" + suffix);
      MaybeAutoOpenPairingPage(status);
      return;
    }

    if (!status.Connected)
    {
      tray.Icon = iconYellow;
      tray.Text = SafeTooltip("未连接" + suffix);
      return;
    }

    tray.Icon = iconGreen;
    tray.Text = SafeTooltip("已连接" + suffix);
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

  private void MaybeStartSilentUpdate(StatusSnapshot? status)
  {
    if (!IsTruthy(GetEnv("AGENT_AUTO_UPDATE", "1"))) return;
    if (DateTime.UtcNow < nextUpdateCheckUtc) return;

    nextUpdateCheckUtc = DateTime.UtcNow.AddHours(6).AddSeconds(Random.Shared.Next(0, 1200));

    if (status == null) return;
    var adminUrl = status.AdminUrl?.Trim() ?? "";

    _ = Task.Run(async () =>
    {
      if (!await updateLock.WaitAsync(0).ConfigureAwait(false)) return;
      try
      {
        var proxyPrefix = GetEnv("AGENT_UPDATE_PROXY_PREFIX", "");
        var manifestUrl = GetEnv("AGENT_UPDATE_MANIFEST_URL", "");

        AgentUpdateManifest? latest = null;
        if (!string.IsNullOrWhiteSpace(adminUrl))
        {
          latest = await TryFetchUpdateManifestFromServer(adminUrl, proxyPrefix).ConfigureAwait(false);
        }
        if (latest == null && !string.IsNullOrWhiteSpace(manifestUrl))
        {
          latest = await TryFetchUpdateManifestFromUrl(manifestUrl, proxyPrefix).ConfigureAwait(false);
        }
        if (latest == null) return;

        var current = ReadCurrentVersion(AppContext.BaseDirectory);
        if (current == null) return;
        if (latest.VersionParsed == null) return;
        if (latest.VersionParsed <= current) return;

        await ApplyUpdateSilently(latest, current, proxyPrefix).ConfigureAwait(false);
      }
      catch (Exception ex)
      {
        AppendUpdateLog($"update failed: {ex.Message}");
      }
      finally
      {
        updateLock.Release();
      }
    });
  }

  private async Task ApplyUpdateSilently(AgentUpdateManifest latest, Version current, string proxyPrefix)
  {
    var baseDir = AppContext.BaseDirectory;
    var isMsiInstall = IsMsiInstall();

    var asset = isMsiInstall ? latest.Msi : latest.Zip;
    var mode = isMsiInstall ? "msi" : "zip";
    if (asset == null && isMsiInstall)
    {
      asset = latest.Zip;
      mode = "zip";
    }
    if (asset == null) return;

    AppendUpdateLog($"update start current={current} latest={latest.Version} mode={mode}");

    var tempRoot = Path.Combine(Path.GetTempPath(), $"taobao-agent-update-{latest.Version}-{Guid.NewGuid():N}");
    Directory.CreateDirectory(tempRoot);

    var fileName = mode == "msi" ? "update.msi" : "update.zip";
    var pkgPath = Path.Combine(tempRoot, fileName);

    await DownloadToFile(ApplyProxyPrefix(asset.Url, proxyPrefix), pkgPath).ConfigureAwait(false);
    if (!VerifySha256(pkgPath, asset.Sha256))
    {
      AppendUpdateLog("sha256 mismatch");
      return;
    }

    var extractedDir = "";
    if (mode == "zip")
    {
      extractedDir = Path.Combine(tempRoot, "extracted");
      Directory.CreateDirectory(extractedDir);
      ZipFile.ExtractToDirectory(pkgPath, extractedDir, overwriteFiles: true);
    }

    StopAgentBestEffort();

    var runner = Path.Combine(tempRoot, "run-update.cmd");
    File.WriteAllText(runner, BuildUpdateRunnerCmd(new UpdateRunnerArgs(
      TrayPid: Environment.ProcessId,
      Mode: mode,
      BaseDir: baseDir,
      PackagePath: pkgPath,
      ExtractedDir: extractedDir,
      TempRoot: tempRoot
    )), System.Text.Encoding.ASCII);

    try
    {
      Process.Start(new ProcessStartInfo
      {
        FileName = "cmd.exe",
        Arguments = $"/c \"\"{runner}\"\"",
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden,
        WorkingDirectory = tempRoot,
      });
    }
    catch (Exception ex)
    {
      AppendUpdateLog($"runner start failed: {ex.Message}");
      return;
    }

    uiContext.Post(_ => ExitThread(), null);
  }

  private async Task<AgentUpdateManifest?> TryFetchUpdateManifestFromServer(string adminUrl, string proxyPrefix)
  {
    try
    {
      var baseUri = new Uri(adminUrl.TrimEnd('/') + "/");
      var url = new Uri(baseUri, "api/agents/latest").ToString();
      return await TryFetchUpdateManifestFromUrl(url, proxyPrefix).ConfigureAwait(false);
    }
    catch
    {
      return null;
    }
  }

  private async Task<AgentUpdateManifest?> TryFetchUpdateManifestFromUrl(string url, string proxyPrefix)
  {
    try
    {
      var finalUrl = ApplyProxyPrefix(url, proxyPrefix);
      using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(12) };
      using var res = await client.GetAsync(finalUrl).ConfigureAwait(false);
      if (!res.IsSuccessStatusCode) return null;

      var json = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
      using var doc = JsonDocument.Parse(json);
      var root = doc.RootElement;

      if (root.ValueKind == JsonValueKind.Object &&
          root.TryGetProperty("success", out var s) &&
          s.ValueKind == JsonValueKind.True &&
          root.TryGetProperty("data", out var data) &&
          data.ValueKind == JsonValueKind.Object)
      {
        root = data;
      }

      if (root.ValueKind != JsonValueKind.Object) return null;

      var version = root.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
      var zip = ParseAsset(root, "zip");
      var msi = ParseAsset(root, "msi");

      return AgentUpdateManifest.Create(version, zip, msi);
    }
    catch
    {
      return null;
    }
  }

  private static AgentUpdateAsset? ParseAsset(JsonElement root, string name)
  {
    if (!root.TryGetProperty(name, out var obj) || obj.ValueKind != JsonValueKind.Object) return null;
    var url = obj.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "";
    var sha = obj.TryGetProperty("sha256", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() ?? "" : "";
    var size = obj.TryGetProperty("size", out var z) && z.ValueKind == JsonValueKind.Number ? z.GetInt64() : 0;
    if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(sha)) return null;
    return new AgentUpdateAsset(url.Trim(), sha.Trim(), size);
  }

  private static string ApplyProxyPrefix(string url, string proxyPrefix)
  {
    var u = (url ?? "").Trim();
    if (string.IsNullOrWhiteSpace(u)) return u;
    var p = (proxyPrefix ?? "").Trim();
    if (string.IsNullOrWhiteSpace(p)) return u;
    if (!p.EndsWith("/")) p += "/";

    if (u.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase) ||
        u.StartsWith("https://api.github.com/", StringComparison.OrdinalIgnoreCase))
    {
      return p + u;
    }

    return u;
  }

  private Version? ReadCurrentVersion(string baseDir)
  {
    try
    {
      var path = Path.Combine(baseDir, "version.txt");
      if (File.Exists(path))
      {
        var raw = File.ReadAllText(path).Trim();
        if (TryParseSemver(raw, out var v)) return v;
      }
    }
    catch { }

    var asmVer = Assembly.GetExecutingAssembly().GetName().Version;
    return asmVer;
  }

  private static bool TryParseSemver(string raw, out Version v)
  {
    v = new Version(0, 0, 0, 0);
    var s = (raw ?? "").Trim().TrimStart('v', 'V');
    if (Version.TryParse(s, out var parsed) && parsed != null)
    {
      v = parsed;
      return true;
    }
    if (Version.TryParse(s + ".0", out parsed) && parsed != null)
    {
      v = parsed;
      return true;
    }
    return false;
  }

  private static bool IsMsiInstall()
  {
    try
    {
      using var key = Registry.LocalMachine.OpenSubKey(@"Software\\slee.cc\\TaobaoAgent");
      var installed = key?.GetValue("installed")?.ToString();
      return installed == "1" || installed?.Equals("true", StringComparison.OrdinalIgnoreCase) == true;
    }
    catch
    {
      return false;
    }
  }

  private void StopAgentBestEffort()
  {
    try
    {
      var agentHome = GetAgentHome();
      var meta = Path.Combine(agentHome, "agent.lock.json");
      if (!File.Exists(meta)) return;
      using var doc = JsonDocument.Parse(File.ReadAllText(meta));
      var root = doc.RootElement;
      var pid = root.TryGetProperty("pid", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : 0;
      if (pid <= 0) return;

      try
      {
        var proc = Process.GetProcessById(pid);
        proc.Kill(entireProcessTree: true);
      }
      catch { }
    }
    catch { }
  }

  private static string GetAgentHome()
  {
    var explicitHome = Environment.GetEnvironmentVariable("TAOBAO_AGENT_HOME");
    if (!string.IsNullOrWhiteSpace(explicitHome)) return explicitHome.Trim();

    var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
    return Path.Combine(programData, "TaobaoAgent");
  }

  private static async Task DownloadToFile(string url, string filePath)
  {
    using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
    using var res = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
    res.EnsureSuccessStatusCode();
    await using var src = await res.Content.ReadAsStreamAsync().ConfigureAwait(false);
    await using var dst = File.Open(filePath, FileMode.Create, FileAccess.Write, FileShare.None);
    await src.CopyToAsync(dst).ConfigureAwait(false);
  }

  private static bool VerifySha256(string filePath, string expectedSha256)
  {
    var expected = (expectedSha256 ?? "").Trim().ToLowerInvariant();
    if (expected.Length != 64) return false;

    try
    {
      using var sha = SHA256.Create();
      using var fs = File.OpenRead(filePath);
      var hash = sha.ComputeHash(fs);
      var actual = Convert.ToHexString(hash).ToLowerInvariant();
      return actual == expected;
    }
    catch
    {
      return false;
    }
  }

  private void AppendUpdateLog(string message)
  {
    try
    {
      var dir = GetAgentHome();
      Directory.CreateDirectory(dir);
      var path = Path.Combine(dir, "updater.log");
      File.AppendAllText(path, $"[{DateTime.UtcNow:O}] {message}\r\n");
    }
    catch { }
  }

  private string GetEnv(string key, string fallback)
  {
    var env = Environment.GetEnvironmentVariable(key);
    if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
    if (envFile.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v)) return v.Trim();
    return fallback;
  }

  private static bool IsTruthy(string raw)
  {
    var v = (raw ?? "").Trim();
    return v == "1" || v.Equals("true", StringComparison.OrdinalIgnoreCase) || v.Equals("yes", StringComparison.OrdinalIgnoreCase) || v.Equals("on", StringComparison.OrdinalIgnoreCase);
  }

  private static Dictionary<string, string> LoadEnvFile(string path)
  {
    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    try
    {
      if (!File.Exists(path)) return map;
      foreach (var line in File.ReadAllLines(path))
      {
        var s = (line ?? "").Trim();
        if (s.Length == 0) continue;
        if (s.StartsWith("#")) continue;
        var idx = s.IndexOf('=');
        if (idx <= 0) continue;
        var k = s[..idx].Trim();
        var v = s[(idx + 1)..].Trim().Trim('"');
        if (k.Length == 0) continue;
        map[k] = v;
      }
    }
    catch { }
    return map;
  }

  private static string BuildUpdateRunnerCmd(UpdateRunnerArgs args)
  {
    var baseDir = args.BaseDir.TrimEnd('\\', '/');
    var trayExe = Path.Combine(baseDir, "TaobaoAgentTray.exe");

    static string Q(string s) => $"\"{s.Replace("\"", "\"\"")}\"";

    if (args.Mode == "msi")
    {
      return
        "@echo off\r\n" +
        "setlocal\r\n" +
        $"set TRAY_PID={args.TrayPid}\r\n" +
        ":wait_tray\r\n" +
        $"tasklist /FI \"PID eq %TRAY_PID%\" | find \"%TRAY_PID%\" >nul\r\n" +
        "if not errorlevel 1 (\r\n" +
        "  timeout /t 1 /nobreak >nul\r\n" +
        "  goto wait_tray\r\n" +
        ")\r\n" +
        $"msiexec.exe /i {Q(args.PackagePath)} /qn /norestart\r\n" +
        $"start \"\" {Q(trayExe)}\r\n" +
        $"rmdir /s /q {Q(args.TempRoot)}\r\n";
    }

    return
      "@echo off\r\n" +
      "setlocal\r\n" +
      $"set TRAY_PID={args.TrayPid}\r\n" +
      ":wait_tray\r\n" +
      $"tasklist /FI \"PID eq %TRAY_PID%\" | find \"%TRAY_PID%\" >nul\r\n" +
      "if not errorlevel 1 (\r\n" +
      "  timeout /t 1 /nobreak >nul\r\n" +
      "  goto wait_tray\r\n" +
      ")\r\n" +
      $"robocopy {Q(args.ExtractedDir)} {Q(baseDir)} /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP /XF .env\r\n" +
      $"start \"\" {Q(trayExe)}\r\n" +
      $"rmdir /s /q {Q(args.TempRoot)}\r\n";
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

  private sealed record AgentUpdateAsset(string Url, string Sha256, long Size);

  private sealed record AgentUpdateManifest(string Version, AgentUpdateAsset? Zip, AgentUpdateAsset? Msi)
  {
    public Version? VersionParsed { get; } = TryParse(Version);

    public static AgentUpdateManifest? Create(string version, AgentUpdateAsset? zip, AgentUpdateAsset? msi)
    {
      var v = (version ?? "").Trim();
      if (string.IsNullOrWhiteSpace(v)) return null;
      return new AgentUpdateManifest(v, zip, msi);
    }

    private static Version? TryParse(string raw)
    {
      if (TryParseSemver(raw, out var v)) return v;
      return null;
    }
  }

  private sealed record UpdateRunnerArgs(int TrayPid, string Mode, string BaseDir, string PackagePath, string ExtractedDir, string TempRoot);
}
