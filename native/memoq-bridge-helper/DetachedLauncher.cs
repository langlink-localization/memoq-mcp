using System;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Text;
using System.Web.Script.Serialization;

namespace LangLinkMemoQBridgeHelper
{
    internal static class DetachedLauncher
    {
        private static readonly HashSet<string> AllowedScriptExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".js",
            ".mjs",
            ".cjs",
            ".ts"
        };

        private static readonly HashSet<string> AllowedWorkerFlags = new HashSet<string>(StringComparer.Ordinal)
        {
            "--memoq-bridge-daemon",
            "--memoq-setup-worker"
        };

        public static Dictionary<string, object> Spawn(string specFilePath)
        {
            if (string.IsNullOrWhiteSpace(specFilePath) || !File.Exists(specFilePath))
            {
                throw new FileNotFoundException("Launch specification file was not found.", specFilePath);
            }

            try
            {
                var rawJson = File.ReadAllText(specFilePath, new UTF8Encoding(false));
                var parsed = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(rawJson) as Dictionary<string, object>;
                if (parsed == null)
                {
                    throw new ArgumentException("Launch specification must be a JSON object.");
                }

                var executable = ReadSafeString(parsed, "executable");
                if (string.IsNullOrEmpty(executable) || !File.Exists(executable))
                {
                    throw new ArgumentException("executable must point to an existing file.");
                }
                if (!string.Equals(Path.GetFileName(executable), "node.exe", StringComparison.OrdinalIgnoreCase))
                {
                    throw new ArgumentException("Only node.exe executables are permitted for detached worker launch.");
                }

                if (!parsed.TryGetValue("args", out var argsObj) || !(argsObj is object[] rawArgs) || rawArgs.Length < 2)
                {
                    throw new ArgumentException("args must contain at least [entrypoint, workerFlag].");
                }

                var argList = new List<string>(rawArgs.Length);
                foreach (var item in rawArgs)
                {
                    if (!(item is string s) || s.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0)
                    {
                        throw new ArgumentException("Each argument must be a single-line string without control characters.");
                    }
                    argList.Add(s);
                }

                var entrypoint = argList[0];
                if (string.IsNullOrWhiteSpace(entrypoint) || !File.Exists(entrypoint))
                {
                    throw new ArgumentException("Worker entrypoint script does not exist.");
                }
                if (!AllowedScriptExtensions.Contains(Path.GetExtension(entrypoint)))
                {
                    throw new ArgumentException("Worker entrypoint must be a .js, .mjs, .cjs, or .ts file.");
                }

                var workerFlag = argList[1];
                if (!AllowedWorkerFlags.Contains(workerFlag))
                {
                    throw new ArgumentException($"Disallowed worker flag: {workerFlag}");
                }

                var workingDirectory = ReadSafeString(parsed, "workingDirectory");
                var commandParts = new List<string>(argList.Count + 1)
                {
                    Program.QuoteArgument(Path.GetFullPath(executable))
                };
                foreach (var arg in argList)
                {
                    commandParts.Add(Program.QuoteArgument(arg));
                }
                var commandLine = string.Join(" ", commandParts);

                using (var startupClass = new ManagementClass("Win32_ProcessStartup"))
                using (var startupInstance = startupClass.CreateInstance())
                using (var processClass = new ManagementClass("Win32_Process"))
                {
                    startupInstance["ShowWindow"] = (ushort)0; // SW_HIDE
                    using (var inParams = processClass.GetMethodParameters("Create"))
                    {
                        inParams["CommandLine"] = commandLine;
                        if (!string.IsNullOrWhiteSpace(workingDirectory) && Directory.Exists(workingDirectory))
                        {
                            inParams["CurrentDirectory"] = Path.GetFullPath(workingDirectory);
                        }
                        inParams["ProcessStartupInformation"] = startupInstance;

                        using (var outParams = processClass.InvokeMethod("Create", inParams, null))
                        {
                            var returnValue = outParams?["ReturnValue"] != null
                                ? Convert.ToUInt32(outParams["ReturnValue"])
                                : 1u;
                            if (returnValue != 0)
                            {
                                throw new InvalidOperationException($"Win32_Process.Create failed with return code {returnValue}.");
                            }

                            var pid = outParams?["ProcessId"] != null
                                ? Convert.ToInt32(outParams["ProcessId"])
                                : 0;
                            if (pid <= 0)
                            {
                                throw new InvalidOperationException("Win32_Process.Create succeeded without returning a valid ProcessId.");
                            }

                            return new Dictionary<string, object>
                            {
                                ["ok"] = true,
                                ["pid"] = pid,
                                ["method"] = "wmi"
                            };
                        }
                    }
                }
            }
            finally
            {
                try
                {
                    if (File.Exists(specFilePath))
                    {
                        File.Delete(specFilePath);
                    }
                }
                catch
                {
                }
            }
        }

        private static string ReadSafeString(Dictionary<string, object> dict, string key)
        {
            if (!dict.TryGetValue(key, out var val) || val == null)
            {
                return null;
            }
            if (!(val is string str) || str.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0)
            {
                throw new ArgumentException($"{key} must be a single-line string without control characters.");
            }
            return str;
        }
    }
}
