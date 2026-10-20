using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("QUTC Launcher")]
[assembly: AssemblyProduct("QUTC Launcher")]
[assembly: AssemblyDescription("QUTC Minecraft Club Launcher bootstrap")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    [STAThread]
    static void Main()
    {
        try
        {
            string self = Assembly.GetExecutingAssembly().Location;
            string dir = Path.GetDirectoryName(self);
            string localDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "QUTC-Launcher");
            string localRuntime = Path.Combine(localDir, "QUTC Launcher.runtime.exe");
            string localBootstrap = Path.Combine(localDir, "QUTC Launcher.exe");
            string siblingRuntime = Path.Combine(dir, "QUTC Launcher.runtime.exe");

            // DSH/沙箱工作区里的 Electron 会崩溃；优先使用 LocalAppData 中的运行时。
            bool restricted = dir.IndexOf(
                "\u5927\u80a5\u9c7c\u5de5\u4f5c\u533a",
                StringComparison.OrdinalIgnoreCase) >= 0;

            string target = null;
            if (restricted && File.Exists(localRuntime))
            {
                target = localRuntime;
            }
            else if (File.Exists(siblingRuntime))
            {
                target = siblingRuntime;
            }
            else if (File.Exists(localRuntime))
            {
                target = localRuntime;
            }
            else if (!restricted && File.Exists(localBootstrap) &&
                     !string.Equals(Path.GetFullPath(localBootstrap), Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase))
            {
                target = localBootstrap;
            }

            if (target == null)
            {
                MessageBox.Show(
                    "QUTC Launcher \u8fd0\u884c\u65f6\u7f3a\u5931\u3002\n\n" +
                    "\u8bf7\u5148\u8fd0\u884c\uff1anode scripts/install-local.js\n" +
                    "\u6216\u628a\u6574\u4e2a QUTC-Launcher \u6587\u4ef6\u5939\u590d\u5236\u5230\u666e\u901a\u76ee\u5f55\u540e\u518d\u8fd0\u884c\u3002",
                    "QUTC Launcher",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            Process.Start(new ProcessStartInfo(target)
            {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(target),
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show("QUTC Launcher \u542f\u52a8\u5931\u8d25:\n" + ex.Message,
                "QUTC Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
