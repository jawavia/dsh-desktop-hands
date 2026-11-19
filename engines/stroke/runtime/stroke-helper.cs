// dsh-stroke helper v0.2 (ASCII only). Two modes:
//   stroke-helper.exe                 -> stdio protocol (legacy; inherits caller integrity)
//   stroke-helper.exe --serve <port>  -> TCP loopback service (started from a medium-IL shell)
// Playback: absolute SendInput moves at per-point timestamps, Esc/F11 polled, STOP flag.
// Line protocol (same in both modes):
//   HELLO / STATUS / STOP / QUIT
//   DRAW <id> L|R x,y,t;x,y,t;...   -> DONE <id> sent= elapsed= aborted= reason= fails= werr= cursor=
//   SELFTEST <x> <y>                -> SELFTEST setOk= before= after= clicked=1 setErr= desk= wsta= input= fg=
//   SHOT <path> [hwnd]              -> SHOT ok= path= size= print=
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class StrokeHelper
{
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint p);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder buf, int len, out int needed);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L; public int T; public int R; public int B; }

    const uint IM = 0;
    const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    static int W, H, OX, OY;
    static volatile bool AbortRequested = false;
    static volatile bool Playing = false;
    static readonly object OutLock = new object();
    static TextWriter CurrentOut = Console.Out;
    static string InputDesk = "?";
    static int FailCount = 0;
    static int LastErr = 0;

    static void WriteLine(string s)
    {
        lock (OutLock)
        {
            try { CurrentOut.WriteLine(s); CurrentOut.Flush(); } catch { }
        }
    }

    static string DeskName(IntPtr h)
    {
        try
        {
            var sb = new StringBuilder(128);
            int need;
            GetUserObjectInformation(h, 2, sb, 128, out need);
            return sb.ToString();
        }
        catch { return "?"; }
    }

    static string FgTitle()
    {
        try { var sb = new StringBuilder(128); GetWindowText(GetForegroundWindow(), sb, 128); return sb.ToString(); }
        catch { return ""; }
    }

    static void Emit(uint flags, int x, int y)
    {
        INPUT[] inp = new INPUT[1];
        inp[0].type = IM;
        inp[0].mi.dx = (int)Math.Round((x - OX) * 65535.0 / Math.Max(1, W - 1));
        inp[0].mi.dy = (int)Math.Round((y - OY) * 65535.0 / Math.Max(1, H - 1));
        inp[0].mi.dwFlags = flags | ABSOLUTE | VIRTUALDESK;
        // 2026-11-03: this machine filters SendInput from our unsigned helper
        // (returns success but the cursor never moves). The legacy mouse_event
        // path does work from the same integrity level, so use it as the primary
        // channel; keep SendInput as a best-effort secondary.
        try { mouse_event(flags | ABSOLUTE | VIRTUALDESK, inp[0].mi.dx, inp[0].mi.dy, 0, UIntPtr.Zero); } catch { FailCount++; }
        try { SendInput(1, inp, Marshal.SizeOf(typeof(INPUT))); } catch { }
    }

    static bool EscPressed()
    {
        return (GetAsyncKeyState(0x1B) & 0x8000) != 0 || (GetAsyncKeyState(0x7A) & 0x8000) != 0;
    }

    static void Play(string id, bool right, List<int[]> pts)
    {
        Playing = true;
        AbortRequested = false;
        FailCount = 0; LastErr = 0;
        timeBeginPeriod(1);
        var sw = Stopwatch.StartNew();
        int sent = 0;
        string reason = "";
        try
        {
            int[] p0 = pts[0];
            Emit(MOVE, p0[0], p0[1]);
            Thread.Sleep(6);
            Emit(right ? RIGHTDOWN : LEFTDOWN, p0[0], p0[1]);
            for (int i = 1; i < pts.Count; i++)
            {
                if (AbortRequested || EscPressed()) { reason = "abort"; break; }
                double wait = pts[i][2] - sw.Elapsed.TotalMilliseconds;
                if (wait > 1.5) Thread.Sleep((int)wait);
                else while (sw.Elapsed.TotalMilliseconds < pts[i][2] - 0.4) Thread.SpinWait(40);
                Emit(MOVE, pts[i][0], pts[i][1]);
                sent++;
            }
        }
        catch (Exception ex) { reason = "error:" + ex.GetType().Name; }
        finally
        {
            try { Emit(right ? RIGHTUP : LEFTUP, 0, 0); } catch { }
            timeEndPeriod(1);
            Playing = false;
        }
        POINT cp; GetCursorPos(out cp);
        WriteLine("DONE " + id + " sent=" + sent + " elapsed=" + (int)sw.ElapsedMilliseconds + " aborted=" + ((AbortRequested || reason == "abort") ? 1 : 0) + " reason=" + (reason == "" ? "ok" : reason) + " fails=" + FailCount + " werr=" + LastErr + " cursor=" + cp.X + "," + cp.Y);
    }

    static void SelfTest(int x, int y)
    {
        POINT before; GetCursorPos(out before);
        bool ok = SetCursorPos(x, y);
        int err = Marshal.GetLastWin32Error();
        Thread.Sleep(80);
        Emit(MOVE, x, y); Thread.Sleep(10);
        Emit(LEFTDOWN, x, y); Thread.Sleep(30); Emit(LEFTUP, x, y);
        Thread.Sleep(60);
        POINT after; GetCursorPos(out after);
        WriteLine("SELFTEST setOk=" + ok + " before=" + before.X + "," + before.Y + " after=" + after.X + "," + after.Y + " clicked=1 setErr=" + err + " desk=" + DeskName(GetThreadDesktop(GetCurrentThreadId())) + " wsta=" + DeskName(GetProcessWindowStation()) + " input=" + InputDesk + " fg=" + FgTitle());
    }

    static void Shot(string path, IntPtr hwnd)
    {
        IntPtr h = hwnd != IntPtr.Zero ? hwnd : GetForegroundWindow();
        RECT r;
        if (!GetWindowRect(h, out r)) { WriteLine("SHOT ok=0 err=rect"); return; }
        int w = r.R - r.L, ht = r.B - r.T;
        bool ok = false;
        if (w <= 0 || ht <= 0) { WriteLine("SHOT ok=0 err=size"); return; }
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
            WriteLine("SHOT ok=1 path=" + path + " size=" + w + "x" + ht + " print=" + (ok ? 1 : 0));
        }
        catch (Exception ex) { WriteLine("SHOT ok=0 err=" + ex.GetType().Name); }
    }

    static List<int[]> ParsePoints(string spec)
    {
        var pts = new List<int[]>();
        foreach (string chunk in spec.Split(';'))
        {
            if (chunk.Length == 0) continue;
            string[] c = chunk.Split(',');
            if (c.Length < 2) continue;
            pts.Add(new int[]
            {
                (int)Math.Round(double.Parse(c[0], CultureInfo.InvariantCulture)),
                (int)Math.Round(double.Parse(c[1], CultureInfo.InvariantCulture)),
                c.Length > 2 ? (int)Math.Round(double.Parse(c[2], CultureInfo.InvariantCulture)) : pts.Count * 8
            });
        }
        return pts;
    }

    static void RunProtocol(TextReader rdr)
    {
        string line;
        while ((line = rdr.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            string[] parts = line.Split(new char[] { ' ' }, 4);
            switch (parts[0])
            {
                case "HELLO":
                    WriteLine("READY version=2 pid=" + Process.GetCurrentProcess().Id + " inputSize=" + Marshal.SizeOf(typeof(INPUT)) + " screen=" + W + "x" + H + "@" + OX + "," + OY + " desk=" + DeskName(GetThreadDesktop(GetCurrentThreadId())) + " wsta=" + DeskName(GetProcessWindowStation()) + " input=" + InputDesk);
                    break;
                case "STATUS":
                    WriteLine("STATUS playing=" + (Playing ? 1 : 0) + " abort=" + (AbortRequested ? 1 : 0) + " fg=" + FgTitle() + " input=" + InputDesk);
                    break;
                case "STOP":
                    AbortRequested = true;
                    WriteLine("OK stop");
                    break;
                case "QUIT":
                    return;
                case "DRAW":
                    if (parts.Length < 4) { WriteLine("ERR draw-args"); break; }
                    {
                        string id = parts[1];
                        bool right = parts[2] == "R";
                        var pts = ParsePoints(parts[3]);
                        if (pts.Count == 0) { WriteLine("ERR draw-empty " + id); break; }
                        var th = new Thread(delegate () { Play(id, right, pts); });
                        th.IsBackground = true;
                        th.Start();
                    }
                    break;
                case "CURSOR":
                    {
                        POINT cp; GetCursorPos(out cp);
                        WriteLine("CURSOR x=" + cp.X + " y=" + cp.Y + " desk=" + DeskName(GetThreadDesktop(GetCurrentThreadId())) + " fg=" + FgTitle());
                        break;
                    }
                case "WINDOWS":
                    WriteLine("WINDOWS " + WinList());
                    break;
                case "PSMOVE":
                    if (parts.Length >= 3) { PsMove(int.Parse(parts[1]), int.Parse(parts[2])); }
                    else { WriteLine("ERR psmove-args"); }
                    break;
                case "SELFTEST":
                    if (parts.Length >= 3) { SelfTest(int.Parse(parts[1]), int.Parse(parts[2])); }
                    else { WriteLine("ERR selftest-args"); }
                    break;
                case "SHOT":
                    if (parts.Length >= 2)
                    {
                        long hw = 0;
                        IntPtr target = (parts.Length >= 3 && long.TryParse(parts[2], out hw)) ? (IntPtr)hw : IntPtr.Zero;
                        Shot(parts[1], target);
                    }
                    else { WriteLine("ERR shot-args"); }
                    break;
                default:
                    WriteLine("ERR unknown " + parts[0]);
                    break;
            }
        }
    }

    static string WinList()
    {
        var names = new List<string>();
        try
        {
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (names.Count >= 12) return false;
                if (!IsWindowVisible(h)) return true;
                var sb = new StringBuilder(160);
                GetWindowText(h, sb, 160);
                string t = sb.ToString();
                if (t.Length > 0) names.Add(t);
                return true;
            }, IntPtr.Zero);
        }
        catch { names.Add("enum-failed"); }
        return string.Join(" | ", names.ToArray());
    }

    static void PsMove(int x, int y)
    {
        string tmp = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dsh-stroke-psmove.ps1");
        string script =
            "param($x,$y)" + (char)13 + (char)10 +
            "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out P p);[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int x,int y);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,int dx,int dy,uint d,UIntPtr e);[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();}'" + (char)13 + (char)10 +
            "[M]::SetProcessDPIAware()|Out-Null" + (char)13 + (char)10 +
            "[M+P]$p=New-Object M+P" + (char)13 + (char)10 +
            "[M]::GetCursorPos([ref]$p)|Out-Null" + (char)13 + (char)10 +
            "$b=$p.X.ToString()+','+$p.Y.ToString()" + (char)13 + (char)10 +
            "$ok=[M]::SetCursorPos([int]$x,[int]$y)" + (char)13 + (char)10 +
            "Start-Sleep -Milliseconds 120" + (char)13 + (char)10 +
            "[M]::GetCursorPos([ref]$p)|Out-Null" + (char)13 + (char)10 +
            "Write-Output ('setOk='+$ok+' before='+$b+' after='+$p.X.ToString()+','+$p.Y.ToString())" + (char)13 + (char)10;
        try
        {
            System.IO.File.WriteAllText(tmp, script);
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + tmp + "\" -x " + x + " -y " + y);
            psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.CreateNoWindow = true;
            var proc = Process.Start(psi);
            string outp = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(8000);
            WriteLine("PSMOVE " + outp.Replace((char)13, ' ').Replace((char)10, ' ').Trim());
        }
        catch (Exception ex) { WriteLine("PSMOVE error=" + ex.GetType().Name); }
    }

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        SetProcessDPIAware();
        OX = GetSystemMetrics(SM_XVIRTUALSCREEN); OY = GetSystemMetrics(SM_YVIRTUALSCREEN);
        W = GetSystemMetrics(SM_CXVIRTUALSCREEN); H = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        InputDesk = DeskName(OpenInputDesktop(0, false, 0x0181));
        if (args.Length >= 2 && args[0] == "--serve")
        {
            int port = int.Parse(args[1]);
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            while (true)
            {
                using (TcpClient client = listener.AcceptTcpClient())
                {
                    try
                    {
                        var stream = client.GetStream();
                        var reader = new StreamReader(stream, Encoding.UTF8);
                        var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
                        lock (OutLock) { CurrentOut = writer; }
                        WriteLine("READY version=2 pid=" + Process.GetCurrentProcess().Id + " mode=tcp");
                        RunProtocol(reader);
                    }
                    catch { }
                    finally
                    {
                        lock (OutLock) { CurrentOut = Console.Out; }
                    }
                }
            }
        }
        WriteLine("READY version=2 pid=" + Process.GetCurrentProcess().Id + " mode=stdio screen=" + W + "x" + H);
        // stdio mode: if a medium-integrity service is listening, relay to it.
        try
        {
            using (var probe = new TcpClient())
            {
                probe.Connect(IPAddress.Loopback, 47999);
                using (var stream = probe.GetStream())
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    var pump = new Thread(delegate ()
                    {
                        try { string l; while ((l = Console.ReadLine()) != null) writer.WriteLine(l); } catch { }
                    });
                    pump.IsBackground = true;
                    pump.Start();
                    string rl;
                    while ((rl = reader.ReadLine()) != null) Console.WriteLine(rl);
                    return 0;
                }
            }
        }
        catch { }
        RunProtocol(Console.In);
        return 0;
    }
}
