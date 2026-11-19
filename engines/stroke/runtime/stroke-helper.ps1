param([int]$Port = 0)
# dsh-stroke helper (PowerShell host). ASCII only.
# Why PS host: on this machine the security software blocks input injection from
# our own unsigned exe (SetCursorPos/SendInput/mouse_event silently fail), while
# signed script hosts (powershell/python) are allowed. So the C# core is compiled
# in-memory by Add-Type and runs inside powershell.exe.
Set-StrictMode -Off
$code = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class StrokeCore
{
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint p);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder buf, int len, out int need);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L; public int T; public int R; public int B; }

    const uint IM = 0;
    const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    const int SM_X = 76, SM_Y = 77, SM_CX = 78, SM_CY = 79;

    static int W, H, OX, OY;
    static volatile bool AbortRequested = false;
    static string InputDesk = "?";

    public static string Init()
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        SetProcessDPIAware();
        OX = GetSystemMetrics(SM_X); OY = GetSystemMetrics(SM_Y);
        W = GetSystemMetrics(SM_CX); H = GetSystemMetrics(SM_CY);
        InputDesk = DeskName(OpenInputDesktop(0, false, 0x0181));
        return "READY version=3 pid=" + Process.GetCurrentProcess().Id + " host=ps screen=" + W + "x" + H + " desk=" + DeskName(GetThreadDesktop(GetCurrentThreadId())) + " input=" + InputDesk;
    }

    static string DeskName(IntPtr h)
    {
        try { var sb = new StringBuilder(128); int n; GetUserObjectInformation(h, 2, sb, 128, out n); return sb.ToString(); } catch { return "?"; }
    }

    static string FgTitle()
    {
        try { var sb = new StringBuilder(160); GetWindowText(GetForegroundWindow(), sb, 160); return sb.ToString(); } catch { return ""; }
    }

    static void Emit(uint flags, int x, int y)
    {
        int dx = (int)Math.Round((x - OX) * 65535.0 / Math.Max(1, W - 1));
        int dy = (int)Math.Round((y - OY) * 65535.0 / Math.Max(1, H - 1));
        try { mouse_event(flags | ABSOLUTE | VIRTUALDESK, dx, dy, 0, UIntPtr.Zero); } catch { }
        try
        {
            INPUT[] inp = new INPUT[1];
            inp[0].type = IM;
            inp[0].mi.dx = dx; inp[0].mi.dy = dy;
            inp[0].mi.dwFlags = flags | ABSOLUTE | VIRTUALDESK;
            SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        }
        catch { }
    }

    static bool EscPressed()
    {
        return (GetAsyncKeyState(0x1B) & 0x8000) != 0 || (GetAsyncKeyState(0x7A) & 0x8000) != 0;
    }

    static List<int[]> Parse(string spec)
    {
        var pts = new List<int[]>();
        foreach (string chunk in spec.Split(';'))
        {
            if (chunk.Length == 0) continue;
            string[] c = chunk.Split(',');
            if (c.Length < 2) continue;
            pts.Add(new int[] {
                (int)Math.Round(double.Parse(c[0], CultureInfo.InvariantCulture)),
                (int)Math.Round(double.Parse(c[1], CultureInfo.InvariantCulture)),
                c.Length > 2 ? (int)Math.Round(double.Parse(c[2], CultureInfo.InvariantCulture)) : pts.Count * 8
            });
        }
        return pts;
    }

    static string Play(string id, bool right, List<int[]> pts)
    {
        AbortRequested = false;
        timeBeginPeriod(1);
        var sw = Stopwatch.StartNew();
        int sent = 0; string reason = "";
        try
        {
            int[] p0 = pts[0];
            Emit(MOVE, p0[0], p0[1]); Thread.Sleep(6);
            Emit(right ? RIGHTDOWN : LEFTDOWN, p0[0], p0[1]);
            for (int i = 1; i < pts.Count; i++)
            {
                if (AbortRequested || EscPressed()) { reason = "abort"; break; }
                double wait = pts[i][2] - sw.Elapsed.TotalMilliseconds;
                if (wait > 1.5) Thread.Sleep((int)wait);
                else while (sw.Elapsed.TotalMilliseconds < pts[i][2] - 0.4) Thread.SpinWait(40);
                Emit(MOVE, pts[i][0], pts[i][1]); sent++;
            }
        }
        catch (Exception ex) { reason = "error:" + ex.GetType().Name; }
        finally
        {
            try { Emit(right ? RIGHTUP : LEFTUP, 0, 0); } catch { }
            timeEndPeriod(1);
        }
        POINT cp; GetCursorPos(out cp);
        return "DONE " + id + " sent=" + sent + " elapsed=" + (int)sw.ElapsedMilliseconds + " aborted=" + ((AbortRequested || reason == "abort") ? 1 : 0) + " reason=" + (reason == "" ? "ok" : reason) + " cursor=" + cp.X + "," + cp.Y;
    }

    static string SelfTest(int x, int y)
    {
        POINT b; GetCursorPos(out b);
        bool ok = SetCursorPos(x, y);
        Thread.Sleep(90);
        Emit(MOVE, x, y); Thread.Sleep(10);
        Emit(LEFTDOWN, x, y); Thread.Sleep(30); Emit(LEFTUP, x, y);
        Thread.Sleep(60);
        POINT a; GetCursorPos(out a);
        return "SELFTEST setOk=" + ok + " before=" + b.X + "," + b.Y + " after=" + a.X + "," + a.Y + " clicked=1 fg=" + FgTitle();
    }

    static string Shot(string path, long hwnd)
    {
        IntPtr h = hwnd != 0 ? (IntPtr)hwnd : GetForegroundWindow();
        RECT r;
        if (!GetWindowRect(h, out r)) return "SHOT ok=0 err=rect";
        int w = r.R - r.L, ht = r.B - r.T;
        if (w <= 0 || ht <= 0) return "SHOT ok=0 err=size";
        bool ok = false;
        try
        {
            using (Bitmap bmp = new Bitmap(w, ht))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    IntPtr dc = g.GetHdc();
                    ok = PrintWindow(h, dc, 2);
                    g.ReleaseHdc(dc);
                    if (!ok) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(w, ht));
                }
                bmp.Save(path, ImageFormat.Png);
            }
            return "SHOT ok=1 path=" + path + " size=" + w + "x" + ht + " print=" + (ok ? 1 : 0);
        }
        catch (Exception ex) { return "SHOT ok=0 err=" + ex.GetType().Name; }
    }

    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public static string ScreenShot(string path)
    {
        try
        {
            System.Threading.Thread.Sleep(350);
            int w = GetSystemMetrics(SM_CX), h = GetSystemMetrics(SM_CY);
            using (Bitmap bmp = new Bitmap(w, h))
            {
                using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
                bmp.Save(path, ImageFormat.Png);
            }
            return "SCREENSHOT ok path=" + path + " size=" + w + "x" + h;
        }
        catch (Exception ex) { return "SCREENSHOT err=" + ex.GetType().Name; }
    }
    public static string NewDoc()
    {
        try
        {
            keybd_event(0x11, 0, 0, UIntPtr.Zero); Thread.Sleep(30);
            keybd_event(0x4E, 0, 0, UIntPtr.Zero); Thread.Sleep(30);
            keybd_event(0x4E, 0, 2, UIntPtr.Zero); Thread.Sleep(30);
            keybd_event(0x11, 0, 2, UIntPtr.Zero);
            return "NEWDOC ok";
        }
        catch (Exception ex) { return "NEWDOC err=" + ex.GetType().Name; }
    }

    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

    public static string RectOf(long h)
    {
        RECT r;
        if (!GetWindowRect((IntPtr)h, out r)) return "rect-fail";
        return r.L + "," + r.T + " " + (r.R - r.L) + "x" + (r.B - r.T);
    }

    public static string Focus(long h)
    {
        IntPtr w = (IntPtr)h;
        try { ShowWindow(w, 9); BringWindowToTop(w); SetForegroundWindow(w); } catch { }
        return "focused";
    }

    static string WinList()
    {
        var names = new List<string>();
        try
        {
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (names.Count >= 10) return false;
                if (!IsWindowVisible(h)) return true;
                var sb = new StringBuilder(160); GetWindowText(h, sb, 160);
                if (sb.Length > 0) names.Add(sb.ToString());
                return true;
            }, IntPtr.Zero);
        }
        catch { }
        return string.Join(" | ", names.ToArray());
    }

    public static string Handle(string line)
    {
        line = (line == null ? "" : line.Trim());
        if (line.Length == 0) return "";
        string[] parts = line.Split(new char[] { ' ' }, 4);
        switch (parts[0])
        {
            case "HELLO": return Init();
            case "STATUS": { POINT cp; GetCursorPos(out cp); return "STATUS playing=0 fg=" + FgTitle() + " input=" + InputDesk + " cursor=" + cp.X + "," + cp.Y; }
            case "CURSOR": { POINT cp; GetCursorPos(out cp); return "CURSOR x=" + cp.X + " y=" + cp.Y; }
            case "WINDOWS": return "WINDOWS " + WinList();
            case "STOP": AbortRequested = true; return "OK stop";
            case "NEWDOC": return NewDoc();
            case "SCREENSHOT": return parts.Length >= 2 ? ScreenShot(parts[1]) : "ERR screenshot-args";
            case "QUIT": return "OK bye";
            case "DRAW":
                if (parts.Length < 4) return "ERR draw-args";
                return Play(parts[1], parts[2] == "R", Parse(parts[3]));
            case "SELFTEST":
                if (parts.Length < 3) return "ERR selftest-args";
                return SelfTest(int.Parse(parts[1]), int.Parse(parts[2]));
            case "SHOT":
                {
                    long hw = 0;
                    if (parts.Length >= 3) long.TryParse(parts[2], out hw);
                    return Shot(parts[1], hw);
                }
            default: return "ERR unknown " + parts[0];
        }
    }
}
"@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing, System.Windows.Forms
[StrokeCore]::Init() | Write-Output
if ($Port -gt 0) {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  $listener.Start()
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
      $writer = New-Object System.IO.StreamWriter($stream, [System.Text.UTF8Encoding]::new($false))
      $writer.AutoFlush = $true
      while (($line = $reader.ReadLine()) -ne $null) {
        $out = [StrokeCore]::Handle($line)
        if ($out -ne "" -and $out -ne $null) { $writer.WriteLine($out) }
      }
    } catch { }
    finally { $client.Close() }
  }
} else {
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ($line.Trim() -eq 'PAINT') {
      $res = @()
      foreach ($p in [System.Diagnostics.Process]::GetProcessesByName('mspaint')) {
        $h = $p.MainWindowHandle
        if ($h -ne [IntPtr]::Zero) { $res += ('hwnd=' + $h.ToInt64() + ' ' + [StrokeCore]::RectOf($h.ToInt64()) + ' ' + [StrokeCore]::Focus($h.ToInt64())) }
      }
      if ($res.Count -eq 0) { $out = 'PAINT none' } else { $out = 'PAINT ' + ($res -join ' ; ') }
      [Console]::Out.WriteLine($out); [Console]::Out.Flush()
      continue
    }
    $out = [StrokeCore]::Handle($line)
    if ($out -ne "" -and $out -ne $null) { [Console]::Out.WriteLine($out); [Console]::Out.Flush() }
  }
}
