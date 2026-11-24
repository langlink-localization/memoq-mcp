using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace LangLinkMemoQBridgeHelper
{
    internal static class Program
    {
        internal const string HelperVersion = "0.1.0";

        [STAThread]
        private static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            try
            {
                if (args.Length == 0 || HasFlag(args, "--version"))
                {
                    WriteJsonLine(new Dictionary<string, object>
                    {
                        ["name"] = "MemoQ.Bridge.Helper",
                        ["version"] = HelperVersion
                    });
                    return 0;
                }

                if (HasFlag(args, "--stdio"))
                {
                    var toolId = ReadArg(args, "--tool-id");
                    var toolName = ReadArg(args, "--tool-name");
                    var bridge = new PreviewPipeBridge(toolId, toolName);
                    bridge.Run();
                    return 0;
                }

                if (HasFlag(args, "--elevate-install"))
                {
                    return RunElevated("--install-plugin", args);
                }

                if (HasFlag(args, "--elevate-uninstall"))
                {
                    return RunElevated("--uninstall-plugin", args);
                }

                if (HasFlag(args, "--install-plugin"))
                {
                    var memoqRoot = RequireArg(args, "--memoq-root");
                    var dllSource = RequireArg(args, "--dll-source");
                    var dllSha256 = RequireArg(args, "--dll-sha256");
                    var programData = ReadArg(args, "--program-data") ?? Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                    var resultFile = ReadArg(args, "--result-file");

                    var result = PluginInstaller.Install(memoqRoot, dllSource, dllSha256, programData);
                    EmitResult(result, resultFile);
                    return 0;
                }

                if (HasFlag(args, "--uninstall-plugin"))
                {
                    var memoqRoot = RequireArg(args, "--memoq-root");
                    var programData = ReadArg(args, "--program-data") ?? Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                    var resultFile = ReadArg(args, "--result-file");

                    var result = PluginInstaller.Uninstall(memoqRoot, programData);
                    EmitResult(result, resultFile);
                    return 0;
                }

                if (HasFlag(args, "--discover-memoq"))
                {
                    var result = PluginInstaller.DiscoverInstallations();
                    WriteJsonLine(result);
                    return 0;
                }

                if (HasFlag(args, "--spawn-detached"))
                {
                    var specFile = RequireArg(args, "--spec-file");
                    var result = DetachedLauncher.Spawn(specFile);
                    WriteJsonLine(result);
                    return 0;
                }

                if (HasFlag(args, "--fetch-plugin-dll"))
                {
                    var url = RequireArg(args, "--url");
                    var outPath = RequireArg(args, "--out");
                    var sha256Csv = ReadArg(args, "--sha256") ?? string.Empty;
                    var resultFile = ReadArg(args, "--result-file");

                    var result = PluginAssetDownloader.DownloadPluginDll(url, outPath, sha256Csv);
                    EmitResult(result, resultFile);
                    return 0;
                }

                throw new ArgumentException("Unknown mode. Expected --stdio, --install-plugin, --uninstall-plugin, --elevate-install, --elevate-uninstall, --discover-memoq, --spawn-detached, --fetch-plugin-dll, or --version.");
            }
            catch (Exception error)
            {
                var resultFile = ReadArg(args, "--result-file");
                var payload = new Dictionary<string, object>
                {
                    ["ok"] = false,
                    ["error"] = error.Message
                };
                try
                {
                    EmitResult(payload, resultFile);
                }
                catch
                {
                    Console.Error.WriteLine(error.Message);
                }
                return 1;
            }
        }

        private static int RunElevated(string targetMode, string[] args)
        {
            var resultFile = ReadArg(args, "--result-file");
            var createdTempResult = false;
            if (string.IsNullOrWhiteSpace(resultFile))
            {
                resultFile = Path.Combine(Path.GetTempPath(), "langlink-memoq-helper-" + Guid.NewGuid().ToString("N") + ".json");
                createdTempResult = true;
            }

            try
            {
                var childArgs = new List<string> { targetMode };
                for (var index = 0; index < args.Length; index += 1)
                {
                    var current = args[index];
                    if (string.Equals(current, "--elevate-install", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(current, "--elevate-uninstall", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    if (string.Equals(current, "--result-file", StringComparison.OrdinalIgnoreCase))
                    {
                        index += 1;
                        continue;
                    }
                    childArgs.Add(QuoteArgument(current));
                }
                childArgs.Add("--result-file");
                childArgs.Add(QuoteArgument(resultFile));

                var exePath = Process.GetCurrentProcess().MainModule.FileName;
                var startInfo = new ProcessStartInfo
                {
                    FileName = exePath,
                    Arguments = string.Join(" ", childArgs),
                    UseShellExecute = true,
                    Verb = "runas",
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                using (var child = Process.Start(startInfo))
                {
                    if (child == null)
                    {
                        throw new InvalidOperationException("Failed to launch elevated helper process.");
                    }

                    child.WaitForExit();
                    if (File.Exists(resultFile))
                    {
                        var json = File.ReadAllText(resultFile, new UTF8Encoding(false));
                        if (!string.IsNullOrWhiteSpace(json))
                        {
                            Console.Out.WriteLine(json.Trim());
                            Console.Out.Flush();
                        }
                    }

                    return child.ExitCode;
                }
            }
            finally
            {
                if (createdTempResult && File.Exists(resultFile))
                {
                    try { File.Delete(resultFile); } catch { }
                }
            }
        }

        internal static string QuoteArgument(string arg)
        {
            if (string.IsNullOrEmpty(arg))
            {
                return "\"\"";
            }

            if (arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
            {
                return arg;
            }

            var builder = new StringBuilder();
            builder.Append('"');
            var backslashes = 0;
            foreach (var ch in arg)
            {
                if (ch == '\\')
                {
                    backslashes += 1;
                    continue;
                }

                if (ch == '"')
                {
                    builder.Append('\\', backslashes * 2 + 1);
                    builder.Append('"');
                    backslashes = 0;
                    continue;
                }

                if (backslashes > 0)
                {
                    builder.Append('\\', backslashes);
                    backslashes = 0;
                }
                builder.Append(ch);
            }

            if (backslashes > 0)
            {
                builder.Append('\\', backslashes * 2);
            }
            builder.Append('"');
            return builder.ToString();
        }

        private static void EmitResult(Dictionary<string, object> payload, string resultFile)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var json = serializer.Serialize(payload);
            if (!string.IsNullOrWhiteSpace(resultFile))
            {
                var parent = Path.GetDirectoryName(resultFile);
                if (!string.IsNullOrWhiteSpace(parent))
                {
                    Directory.CreateDirectory(parent);
                }
                File.WriteAllText(resultFile, json, new UTF8Encoding(false));
            }
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }

        private static void WriteJsonLine(Dictionary<string, object> payload)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            Console.Out.WriteLine(serializer.Serialize(payload));
            Console.Out.Flush();
        }

        private static bool HasFlag(string[] args, string flag)
        {
            foreach (var arg in args)
            {
                if (string.Equals(arg, flag, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static string ReadArg(string[] args, string key)
        {
            for (var index = 0; index < args.Length - 1; index += 1)
            {
                if (string.Equals(args[index], key, StringComparison.OrdinalIgnoreCase))
                {
                    return args[index + 1];
                }
            }
            return null;
        }

        private static string RequireArg(string[] args, string key)
        {
            var value = ReadArg(args, key);
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new ArgumentException($"Missing required argument: {key}");
            }
            return value;
        }
    }
}
