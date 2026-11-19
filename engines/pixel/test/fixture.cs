// Acceptance fixture for dsh-click-matrix.
// A small topmost WinForms window with three labeled buttons. Every real click
// is appended to <logPath> as "<ticks>|<control>|<screenX>|<screenY>|<foregroundTitle>".
// Window/button screen coordinates are written to <boundsPath> as JSON.
// The process exits when <stopPath> exists (checked every 300 ms).
//
// Args: <logPath> <boundsPath> <stopPath>
// ASCII source only.

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace ClickMatrixFixture
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch { try { SetProcessDPIAware(); } catch { } }
            string logPath = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "cm-fixture.log");
            string boundsPath = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "cm-fixture-bounds.json");
            string stopPath = args.Length > 2 ? args[2] : Path.Combine(Path.GetTempPath(), "cm-fixture.stop");
            if (File.Exists(logPath)) File.Delete(logPath);
            if (File.Exists(boundsPath)) File.Delete(boundsPath);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new FixtureForm(logPath, boundsPath, stopPath));
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
    }

    internal sealed class FixtureForm : Form
    {
        private readonly string logPath;
        private readonly string boundsPath;
        private readonly string stopPath;
        private readonly Button btnA;
        private readonly Button btnB;
        private readonly Button btnC;
        private readonly TextBox typeBox;
        private readonly Timer stopTimer;

        public FixtureForm(string logPath, string boundsPath, string stopPath)
        {
            this.logPath = logPath;
            this.boundsPath = boundsPath;
            this.stopPath = stopPath;
            Text = "DSH ClickMatrix Fixture";
            ClientSize = new Size(460, 300);
            StartPosition = FormStartPosition.Manual;
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Left + (int)(wa.Width * 0.55), wa.Top + (int)(wa.Height * 0.12));
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            TopMost = true;

            btnA = MakeButton("TARGET-A", new Point(30, 40), new Size(170, 64));
            btnB = MakeButton("TARGET-B", new Point(30, 130), new Size(170, 64));
            btnC = MakeButton("TARGET-C", new Point(240, 40), new Size(170, 64));

            typeBox = new TextBox();
            typeBox.Name = "type-box";
            typeBox.Location = new Point(240, 178);
            typeBox.Size = new Size(195, 26);
            typeBox.Font = new Font("Segoe UI", 10f);
            typeBox.TextChanged += delegate { WriteTypeBox(); };
            Controls.Add(typeBox);
            Label typeHint = new Label();
            typeHint.Text = "type target";
            typeHint.AutoSize = true;
            typeHint.Location = new Point(240, 208);
            Controls.Add(typeHint);

            Label note = new Label();
            note.Text = "click-matrix acceptance fixture";
            note.AutoSize = true;
            note.Location = new Point(240, 140);
            Controls.Add(note);

            MouseClick += delegate(object sender, MouseEventArgs e)
            {
                Point p = Cursor.Position;
                Log("FORM", p.X, p.Y);
            };

            stopTimer = new Timer();
            stopTimer.Interval = 300;
            stopTimer.Tick += delegate
            {
                if (File.Exists(stopPath)) { stopTimer.Stop(); Close(); }
            };
        }

        private Button MakeButton(string name, Point location, Size size)
        {
            Button b = new Button();
            b.Name = name;
            b.Text = name;
            b.Location = location;
            b.Size = size;
            b.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            b.Click += delegate(object sender, EventArgs e)
            {
                Point p = Cursor.Position;
                Log(name, p.X, p.Y);
            };
            Controls.Add(b);
            return b;
        }

        private void WriteTypeBox()
        {
            try
            {
                string dir = Path.GetDirectoryName(logPath);
                if (dir != null && dir.Length > 0)
                {
                    File.WriteAllText(Path.Combine(dir, "typebox.txt"), typeBox.Text ?? "", new UTF8Encoding(false));
                }
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            WriteBounds();
            stopTimer.Start();
        }

        private void WriteBounds()
        {
            try
            {
                Point a = btnA.PointToScreen(new Point(btnA.Width / 2, btnA.Height / 2));
                Point b = btnB.PointToScreen(new Point(btnB.Width / 2, btnB.Height / 2));
                Point c = btnC.PointToScreen(new Point(btnC.Width / 2, btnC.Height / 2));
                Rectangle r = Bounds;
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"title\":\"").Append(Text).Append("\",");
                sb.Append("\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id).Append(",");
                sb.Append("\"window\":[").Append(r.Left).Append(",").Append(r.Top).Append(",").Append(r.Width).Append(",").Append(r.Height).Append("],");
                sb.Append("\"buttons\":{");
                sb.Append("\"A\":[").Append(a.X).Append(",").Append(a.Y).Append("],");
                sb.Append("\"B\":[").Append(b.X).Append(",").Append(b.Y).Append("],");
                sb.Append("\"C\":[").Append(c.X).Append(",").Append(c.Y).Append("]}}");
                File.WriteAllText(boundsPath, sb.ToString(), new UTF8Encoding(false));
            }
            catch { }
        }

        private void Log(string control, int screenX, int screenY)
        {
            try
            {
                string fg = "";
                IntPtr h = GetForegroundWindow();
                if (h != IntPtr.Zero)
                {
                    StringBuilder sb = new StringBuilder(256);
                    GetWindowTextW(h, sb, sb.Capacity);
                    fg = sb.ToString().Replace("|", " ");
                }
                string line = DateTime.UtcNow.Ticks + "|" + control + "|" + screenX + "|" + screenY + "|" + fg + "\n";
                File.AppendAllText(logPath, line, new UTF8Encoding(false));
            }
            catch { }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);
    }
}
