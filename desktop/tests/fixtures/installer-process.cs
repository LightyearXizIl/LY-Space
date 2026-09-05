using System;
using System.IO;
using System.Threading;

class InstallerProcess {
    static void Main(string[] args) {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        if (Array.IndexOf(args, "--lyspace-quit-for-install") >= 0) {
            File.WriteAllText(Path.Combine(directory, "request.txt"), string.Join("\n", args));
            return;
        }
        File.WriteAllText(Path.Combine(directory, "ready.txt"), "ready");
        for (int i = 0; i < 600; i++) {
            if (File.Exists(Path.Combine(directory, "request.txt")) && Array.IndexOf(args, "--refuse") < 0) {
                Thread.Sleep(500);
                File.WriteAllText(Path.Combine(directory, "saved.txt"), "saved before exit");
                return;
            }
            Thread.Sleep(100);
        }
    }
}
