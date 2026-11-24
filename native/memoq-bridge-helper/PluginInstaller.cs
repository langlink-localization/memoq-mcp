using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml.Linq;
using Microsoft.Win32;

namespace LangLinkMemoQBridgeHelper
{
    internal static class PluginInstaller
    {
        private const string PluginDllName = "MemoQ.AI.Hub.Plugin.dll";
        private const string LegacyPluginDllName = "MemoQ.AI.Desktop.Plugin.dll";
        private const string ClientDevConfigName = "ClientDevConfig.xml";
        private const string InstallMarkerName = ".langlink-memoq-install.json";
        private static readonly string[] SupportedVersionDirs = { "memoQ-10", "memoQ-11", "memoQ-12" };

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool DeleteFileW(string lpFileName);

        private static string NormalizeRootPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return string.Empty;
            }
            return Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        private static string RootKey(string normalizedRoot)
        {
            return (normalizedRoot ?? string.Empty).ToLowerInvariant();
        }

        private static string CleanPathValue(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return string.Empty;
            }
            var trimmed = raw.Trim();
            if (trimmed.StartsWith("\"", StringComparison.Ordinal) && trimmed.EndsWith("\"", StringComparison.Ordinal) && trimmed.Length >= 2)
            {
                trimmed = trimmed.Substring(1, trimmed.Length - 2).Trim();
            }
            return trimmed;
        }

        private static string ExtractDirectoryFromIconPath(string rawIcon)
        {
            if (string.IsNullOrWhiteSpace(rawIcon))
            {
                return string.Empty;
            }
            var cleaned = rawIcon.Trim();
            cleaned = Regex.Replace(cleaned, @",\s*-?\d+\s*$", string.Empty);
            cleaned = CleanPathValue(cleaned);
            if (string.IsNullOrWhiteSpace(cleaned))
            {
                return string.Empty;
            }
            return Path.GetDirectoryName(cleaned) ?? string.Empty;
        }

        private static string ExtractMemoQVersion(string normalizedRoot)
        {
            try
            {
                var folderName = Path.GetFileName(normalizedRoot) ?? string.Empty;
                var match = Regex.Match(folderName, @"memoq[-_\s]?(\d+)", RegexOptions.IgnoreCase);
                if (match.Success)
                {
                    return match.Groups[1].Value;
                }
                var exePath = Path.Combine(normalizedRoot, "MemoQ.exe");
                if (File.Exists(exePath))
                {
                    var versionInfo = FileVersionInfo.GetVersionInfo(exePath);
                    if (versionInfo.FileMajorPart > 0)
                    {
                        return versionInfo.FileMajorPart.ToString();
                    }
                }
            }
            catch
            {
            }
            return "custom";
        }

        public static Dictionary<string, object> DiscoverInstallations()
        {
            var roots = new List<Dictionary<string, object>>();
            var seen = new HashSet<string>(StringComparer.Ordinal);

            void TryAddCandidate(string candidateDir, string source)
            {
                try
                {
                    var cleaned = CleanPathValue(candidateDir);
                    if (string.IsNullOrWhiteSpace(cleaned) || !Directory.Exists(cleaned))
                    {
                        return;
                    }
                    var normalizedRoot = NormalizeRootPath(cleaned);
                    if (string.IsNullOrEmpty(normalizedRoot))
                    {
                        return;
                    }
                    var addinsDir = Path.Combine(normalizedRoot, "Addins");
                    if (!Directory.Exists(addinsDir))
                    {
                        return;
                    }
                    var key = RootKey(normalizedRoot);
                    if (!seen.Add(key))
                    {
                        return;
                    }
                    roots.Add(new Dictionary<string, object>
                    {
                        ["version"] = ExtractMemoQVersion(normalizedRoot),
                        ["rootDir"] = normalizedRoot,
                        ["source"] = source
                    });
                }
                catch
                {
                }
            }

            // 1. Running MemoQ.exe processes
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ExecutablePath FROM Win32_Process WHERE Name = 'MemoQ.exe'"))
                using (var results = searcher.Get())
                {
                    foreach (ManagementObject proc in results)
                    {
                        using (proc)
                        {
                            var exePath = proc["ExecutablePath"] as string;
                            if (!string.IsNullOrWhiteSpace(exePath))
                            {
                                TryAddCandidate(Path.GetDirectoryName(exePath), "running-process");
                            }
                        }
                    }
                }
            }
            catch
            {
            }

            // 2. Windows Registry Uninstall keys (64-bit HKLM, 32-bit HKLM, HKCU)
            var regTargets = new[]
            {
                Tuple.Create(RegistryHive.LocalMachine, RegistryView.Registry64),
                Tuple.Create(RegistryHive.LocalMachine, RegistryView.Registry32),
                Tuple.Create(RegistryHive.CurrentUser, RegistryView.Default)
            };
            foreach (var target in regTargets)
            {
                try
                {
                    using (var baseKey = RegistryKey.OpenBaseKey(target.Item1, target.Item2))
                    using (var uninstallKey = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
                    {
                        if (uninstallKey == null)
                        {
                            continue;
                        }
                        foreach (var subKeyName in uninstallKey.GetSubKeyNames())
                        {
                            try
                            {
                                using (var subKey = uninstallKey.OpenSubKey(subKeyName))
                                {
                                    if (subKey == null)
                                    {
                                        continue;
                                    }
                                    var displayName = subKey.GetValue("DisplayName") as string;
                                    if (string.IsNullOrWhiteSpace(displayName)
                                        || displayName.IndexOf("memoq", StringComparison.OrdinalIgnoreCase) < 0)
                                    {
                                        continue;
                                    }
                                    var installLocation = subKey.GetValue("InstallLocation") as string;
                                    if (!string.IsNullOrWhiteSpace(installLocation))
                                    {
                                        TryAddCandidate(installLocation, "registry");
                                    }
                                    var displayIcon = subKey.GetValue("DisplayIcon") as string;
                                    if (!string.IsNullOrWhiteSpace(displayIcon))
                                    {
                                        TryAddCandidate(ExtractDirectoryFromIconPath(displayIcon), "registry");
                                    }
                                }
                            }
                            catch
                            {
                            }
                        }
                    }
                }
                catch
                {
                }
            }

            // 3. Fixed local drives
            try
            {
                foreach (var drive in DriveInfo.GetDrives())
                {
                    try
                    {
                        if (drive.DriveType != DriveType.Fixed || !drive.IsReady)
                        {
                            continue;
                        }
                        var driveRoot = drive.RootDirectory.FullName;
                        var baseDirs = new[]
                        {
                            Path.Combine(driveRoot, "Program Files", "memoQ"),
                            Path.Combine(driveRoot, "Program Files (x86)", "memoQ"),
                            Path.Combine(driveRoot, "memoQ")
                        };
                        foreach (var baseDir in baseDirs)
                        {
                            try
                            {
                                if (!Directory.Exists(baseDir))
                                {
                                    continue;
                                }
                                foreach (var subDir in Directory.GetDirectories(baseDir, "memoQ-*"))
                                {
                                    TryAddCandidate(subDir, "drive-scan");
                                }
                            }
                            catch
                            {
                            }
                        }
                    }
                    catch
                    {
                    }
                }
            }
            catch
            {
            }

            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["roots"] = roots
            };
        }

        public static Dictionary<string, object> Install(string memoqRoot, string dllSource, string expectedSha256, string programDataDir)
        {
            if (string.IsNullOrWhiteSpace(memoqRoot))
            {
                throw new ArgumentException("memoqRoot is required.");
            }
            if (string.IsNullOrWhiteSpace(dllSource) || !File.Exists(dllSource))
            {
                throw new FileNotFoundException("Plugin DLL source file was not found.", dllSource);
            }
            if (string.IsNullOrWhiteSpace(expectedSha256))
            {
                throw new ArgumentException("expectedSha256 is required.");
            }
            if (string.IsNullOrWhiteSpace(programDataDir))
            {
                throw new ArgumentException("programDataDir is required.");
            }

            var resolvedRoot = NormalizeRootPath(memoqRoot);
            var addinsDir = Path.Combine(resolvedRoot, "Addins");
            if (!Directory.Exists(addinsDir))
            {
                throw new DirectoryNotFoundException($"memoQ Addins directory was not found: {addinsDir}");
            }

            var actualSha256 = ComputeSha256(dllSource);
            if (!string.Equals(actualSha256, expectedSha256.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"Plugin DLL SHA-256 mismatch. Expected {expectedSha256}, actual {actualSha256}.");
            }

            var dllTarget = Path.Combine(addinsDir, PluginDllName);
            var legacyTarget = Path.Combine(addinsDir, LegacyPluginDllName);

            CopyFileAtomically(dllSource, dllTarget);
            RemoveMarkOfTheWeb(dllTarget);

            var legacyRemoved = false;
            if (File.Exists(legacyTarget))
            {
                File.Delete(legacyTarget);
                legacyRemoved = true;
            }

            var normalizedProgramData = NormalizeRootPath(programDataDir);
            var memoqProgramData = Path.Combine(normalizedProgramData, "MemoQ");
            Directory.CreateDirectory(memoqProgramData);
            var clientDevConfigPath = Path.Combine(memoqProgramData, ClientDevConfigName);
            var markerPath = Path.Combine(memoqProgramData, InstallMarkerName);

            var existingMarker = ReadMarker(markerPath);
            var installations = ExtractInstallations(existingMarker);
            var clientDevConfigCreated = false;
            string backupPath = null;
            string previousLoadUnsignedPlugins = null;

            if (!File.Exists(clientDevConfigPath))
            {
                var doc = new XDocument(
                    new XDeclaration("1.0", "utf-8", null),
                    new XElement("ClientDevConfig", new XElement("LoadUnsignedPlugins", "true"))
                );
                SaveXmlAtomically(doc, clientDevConfigPath);
                clientDevConfigCreated = true;
            }
            else
            {
                var doc = XDocument.Load(clientDevConfigPath, LoadOptions.PreserveWhitespace);
                var root = doc.Root;
                if (root == null)
                {
                    throw new InvalidOperationException($"Existing {ClientDevConfigName} has no XML root element.");
                }

                var loadElem = root.Element("LoadUnsignedPlugins");
                previousLoadUnsignedPlugins = loadElem?.Value;

                var timestamp = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
                backupPath = Path.Combine(memoqProgramData, $"{ClientDevConfigName}.bak.{timestamp}");
                File.Copy(clientDevConfigPath, backupPath, overwrite: true);

                if (!string.Equals(loadElem?.Value?.Trim(), "true", StringComparison.OrdinalIgnoreCase))
                {
                    if (loadElem == null)
                    {
                        root.Add(new XElement("LoadUnsignedPlugins", "true"));
                    }
                    else
                    {
                        loadElem.Value = "true";
                    }
                    SaveXmlAtomically(doc, clientDevConfigPath);
                }

                if (existingMarker != null && existingMarker.TryGetValue("clientDevConfigCreated", out var prevCreated) && prevCreated is bool b && b)
                {
                    clientDevConfigCreated = true;
                    previousLoadUnsignedPlugins = null;
                }
                else if (existingMarker != null && existingMarker.ContainsKey("previousLoadUnsignedPlugins"))
                {
                    previousLoadUnsignedPlugins = existingMarker["previousLoadUnsignedPlugins"] as string;
                }
            }

            var installedAt = DateTime.UtcNow.ToString("o");
            installations[RootKey(resolvedRoot)] = new Dictionary<string, object>
            {
                ["memoqRoot"] = resolvedRoot,
                ["dllTarget"] = dllTarget,
                ["dllSha256"] = actualSha256,
                ["installedAt"] = installedAt
            };

            var marker = new Dictionary<string, object>
            {
                ["memoqRoot"] = resolvedRoot,
                ["dllTarget"] = dllTarget,
                ["dllSha256"] = actualSha256,
                ["clientDevConfigPath"] = clientDevConfigPath,
                ["clientDevConfigCreated"] = clientDevConfigCreated,
                ["previousLoadUnsignedPlugins"] = previousLoadUnsignedPlugins,
                ["backupPath"] = backupPath ?? (existingMarker != null && existingMarker.ContainsKey("backupPath") ? existingMarker["backupPath"] : null),
                ["installedAt"] = installedAt,
                ["installations"] = installations
            };
            WriteMarker(markerPath, marker);

            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["action"] = "install",
                ["memoqRoot"] = resolvedRoot,
                ["dllTarget"] = dllTarget,
                ["dllSha256"] = actualSha256,
                ["legacyRemoved"] = legacyRemoved,
                ["clientDevConfigPath"] = clientDevConfigPath,
                ["clientDevConfigCreated"] = clientDevConfigCreated,
                ["backupPath"] = backupPath ?? string.Empty
            };
        }

        public static Dictionary<string, object> Uninstall(string memoqRoot, string programDataDir)
        {
            if (string.IsNullOrWhiteSpace(memoqRoot))
            {
                throw new ArgumentException("memoqRoot is required.");
            }
            if (string.IsNullOrWhiteSpace(programDataDir))
            {
                throw new ArgumentException("programDataDir is required.");
            }

            var resolvedRoot = NormalizeRootPath(memoqRoot);
            var rootKey = RootKey(resolvedRoot);
            var addinsDir = Path.Combine(resolvedRoot, "Addins");
            var dllTarget = Path.Combine(addinsDir, PluginDllName);
            var dllRemoved = false;
            if (File.Exists(dllTarget))
            {
                File.Delete(dllTarget);
                dllRemoved = true;
            }

            var normalizedProgramData = NormalizeRootPath(programDataDir);
            var memoqProgramData = Path.Combine(normalizedProgramData, "MemoQ");
            var clientDevConfigPath = Path.Combine(memoqProgramData, ClientDevConfigName);
            var markerPath = Path.Combine(memoqProgramData, InstallMarkerName);
            var marker = ReadMarker(markerPath);
            var installations = ExtractInstallations(marker);
            var matchedThisRoot = installations.Remove(rootKey);

            var remainingTracked = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            foreach (var kvp in installations)
            {
                var entryRoot = kvp.Value.TryGetValue("memoqRoot", out var rObj)
                    ? NormalizeRootPath(rObj as string)
                    : NormalizeRootPath(kvp.Key);
                var entryDll = kvp.Value.TryGetValue("dllTarget", out var dObj) ? dObj as string : null;
                if (string.IsNullOrEmpty(entryDll) && !string.IsNullOrEmpty(entryRoot))
                {
                    entryDll = Path.Combine(entryRoot, "Addins", PluginDllName);
                }
                if (!string.IsNullOrEmpty(entryDll) && File.Exists(entryDll))
                {
                    remainingTracked[kvp.Key] = kvp.Value;
                }
            }

            var clientDevConfigAction = "unchanged";
            if (marker != null && (matchedThisRoot || dllRemoved))
            {
                var otherInstalled = remainingTracked.Count > 0 || HasOtherInstalledPlugin(resolvedRoot, normalizedProgramData);
                if (otherInstalled)
                {
                    clientDevConfigAction = "preserved_other_versions";
                    if (matchedThisRoot)
                    {
                        var primary = remainingTracked.Count > 0 ? remainingTracked.Values.First() : null;
                        var updatedMarker = new Dictionary<string, object>
                        {
                            ["memoqRoot"] = primary != null && primary.TryGetValue("memoqRoot", out var pmr) ? pmr : string.Empty,
                            ["dllTarget"] = primary != null && primary.TryGetValue("dllTarget", out var pdt) ? pdt : string.Empty,
                            ["dllSha256"] = primary != null && primary.TryGetValue("dllSha256", out var pds) ? pds : string.Empty,
                            ["clientDevConfigPath"] = marker.TryGetValue("clientDevConfigPath", out var cdc) ? cdc : clientDevConfigPath,
                            ["clientDevConfigCreated"] = marker.TryGetValue("clientDevConfigCreated", out var cdcc) && cdcc is bool cb && cb,
                            ["previousLoadUnsignedPlugins"] = marker.ContainsKey("previousLoadUnsignedPlugins") ? marker["previousLoadUnsignedPlugins"] : null,
                            ["backupPath"] = marker.ContainsKey("backupPath") ? marker["backupPath"] : null,
                            ["installedAt"] = primary != null && primary.TryGetValue("installedAt", out var pia) ? pia : DateTime.UtcNow.ToString("o"),
                            ["installations"] = remainingTracked
                        };
                        WriteMarker(markerPath, updatedMarker);
                    }
                }
                else if (matchedThisRoot || (dllRemoved && remainingTracked.Count == 0))
                {
                    if (File.Exists(clientDevConfigPath))
                    {
                        var created = marker.TryGetValue("clientDevConfigCreated", out var cVal) && cVal is bool cBool && cBool;
                        var doc = XDocument.Load(clientDevConfigPath, LoadOptions.PreserveWhitespace);
                        var root = doc.Root;
                        if (created)
                        {
                            var onlyLoadUnsigned = root != null && root.Elements().All(el => string.Equals(el.Name.LocalName, "LoadUnsignedPlugins", StringComparison.Ordinal));
                            if (onlyLoadUnsigned)
                            {
                                File.Delete(clientDevConfigPath);
                                clientDevConfigAction = "deleted";
                            }
                            else
                            {
                                clientDevConfigAction = "preserved_modified";
                            }
                        }
                        else if (root != null)
                        {
                            var previous = marker.ContainsKey("previousLoadUnsignedPlugins") ? marker["previousLoadUnsignedPlugins"] as string : null;
                            var loadElem = root.Element("LoadUnsignedPlugins");
                            if (previous == null)
                            {
                                if (loadElem != null)
                                {
                                    loadElem.Remove();
                                    SaveXmlAtomically(doc, clientDevConfigPath);
                                    clientDevConfigAction = "reverted_element_removed";
                                }
                            }
                            else if (loadElem != null && !string.Equals(loadElem.Value, previous, StringComparison.Ordinal))
                            {
                                loadElem.Value = previous;
                                SaveXmlAtomically(doc, clientDevConfigPath);
                                clientDevConfigAction = "reverted_element_value";
                            }
                        }
                    }

                    if (File.Exists(markerPath))
                    {
                        File.Delete(markerPath);
                    }
                }
            }

            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["action"] = "uninstall",
                ["memoqRoot"] = resolvedRoot,
                ["dllTarget"] = dllTarget,
                ["dllRemoved"] = dllRemoved,
                ["clientDevConfigPath"] = clientDevConfigPath,
                ["clientDevConfigAction"] = clientDevConfigAction
            };
        }

        private static Dictionary<string, Dictionary<string, object>> ExtractInstallations(Dictionary<string, object> marker)
        {
            var result = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            if (marker == null)
            {
                return result;
            }

            if (marker.TryGetValue("installations", out var instObj) && instObj is Dictionary<string, object> instDict)
            {
                foreach (var kvp in instDict)
                {
                    if (kvp.Value is Dictionary<string, object> entry)
                    {
                        var entryRoot = entry.TryGetValue("memoqRoot", out var mr)
                            ? NormalizeRootPath(mr as string)
                            : NormalizeRootPath(kvp.Key);
                        if (!string.IsNullOrEmpty(entryRoot))
                        {
                            var copy = new Dictionary<string, object>(entry)
                            {
                                ["memoqRoot"] = entryRoot
                            };
                            result[RootKey(entryRoot)] = copy;
                        }
                    }
                }
            }

            if (result.Count == 0 && marker.TryGetValue("memoqRoot", out var legacyRootObj) && legacyRootObj is string legacyRootStr && !string.IsNullOrWhiteSpace(legacyRootStr))
            {
                var normLegacy = NormalizeRootPath(legacyRootStr);
                var legacyDll = marker.TryGetValue("dllTarget", out var dt) && dt is string dts && !string.IsNullOrWhiteSpace(dts)
                    ? dts
                    : Path.Combine(normLegacy, "Addins", PluginDllName);
                result[RootKey(normLegacy)] = new Dictionary<string, object>
                {
                    ["memoqRoot"] = normLegacy,
                    ["dllTarget"] = legacyDll,
                    ["dllSha256"] = marker.TryGetValue("dllSha256", out var ds) ? ds : string.Empty,
                    ["installedAt"] = marker.TryGetValue("installedAt", out var ia) ? ia : string.Empty
                };
            }

            return result;
        }

        private static bool HasOtherInstalledPlugin(string resolvedRoot, string normalizedProgramData)
        {
            var rootKey = RootKey(resolvedRoot);
            var candidateDirs = new List<string>();
            var parentDir = Path.GetDirectoryName(resolvedRoot);
            if (!string.IsNullOrEmpty(parentDir))
            {
                foreach (var verDir in SupportedVersionDirs)
                {
                    candidateDirs.Add(Path.Combine(parentDir, verDir));
                }
            }

            var systemProgramData = NormalizeRootPath(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
            if (string.Equals(normalizedProgramData, systemProgramData, StringComparison.OrdinalIgnoreCase))
            {
                foreach (var envVar in new[] { "ProgramFiles", "ProgramFiles(x86)" })
                {
                    var baseDir = Environment.GetEnvironmentVariable(envVar);
                    if (!string.IsNullOrEmpty(baseDir))
                    {
                        foreach (var verDir in SupportedVersionDirs)
                        {
                            candidateDirs.Add(Path.Combine(baseDir, "memoQ", verDir));
                        }
                    }
                }
            }

            foreach (var dir in candidateDirs)
            {
                var norm = NormalizeRootPath(dir);
                if (string.IsNullOrEmpty(norm) || string.Equals(RootKey(norm), rootKey, StringComparison.Ordinal))
                {
                    continue;
                }
                if (File.Exists(Path.Combine(norm, "Addins", PluginDllName)))
                {
                    return true;
                }
            }
            return false;
        }

        private static string ComputeSha256(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
            {
                var hash = sha.ComputeHash(stream);
                return BitConverter.ToString(hash).Replace("-", string.Empty).ToUpperInvariant();
            }
        }

        private static void CopyFileAtomically(string source, string destination)
        {
            var dir = Path.GetDirectoryName(destination);
            var temp = Path.Combine(dir, Path.GetFileName(destination) + "." + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.Copy(source, temp, overwrite: true);
                if (File.Exists(destination))
                {
                    File.Replace(temp, destination, null);
                }
                else
                {
                    File.Move(temp, destination);
                }
            }
            finally
            {
                if (File.Exists(temp))
                {
                    try { File.Delete(temp); } catch { }
                }
            }
        }

        private static void SaveXmlAtomically(XDocument doc, string destination)
        {
            var dir = Path.GetDirectoryName(destination);
            Directory.CreateDirectory(dir);
            var temp = Path.Combine(dir, Path.GetFileName(destination) + "." + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (var writer = new StreamWriter(temp, append: false, new UTF8Encoding(false)))
                {
                    doc.Save(writer);
                }
                if (File.Exists(destination))
                {
                    File.Replace(temp, destination, null);
                }
                else
                {
                    File.Move(temp, destination);
                }
            }
            finally
            {
                if (File.Exists(temp))
                {
                    try { File.Delete(temp); } catch { }
                }
            }
        }

        private static void RemoveMarkOfTheWeb(string filePath)
        {
            try
            {
                DeleteFileW(filePath + ":Zone.Identifier");
            }
            catch
            {
            }
        }

        private static Dictionary<string, object> ReadMarker(string markerPath)
        {
            try
            {
                if (!File.Exists(markerPath))
                {
                    return null;
                }
                var raw = File.ReadAllText(markerPath, new UTF8Encoding(false));
                return new JavaScriptSerializer().DeserializeObject(raw) as Dictionary<string, object>;
            }
            catch
            {
                return null;
            }
        }

        private static void WriteMarker(string markerPath, Dictionary<string, object> marker)
        {
            var json = new JavaScriptSerializer().Serialize(marker);
            var temp = markerPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temp, json, new UTF8Encoding(false));
                if (File.Exists(markerPath))
                {
                    File.Replace(temp, markerPath, null);
                }
                else
                {
                    File.Move(temp, markerPath);
                }
            }
            finally
            {
                if (File.Exists(temp))
                {
                    try { File.Delete(temp); } catch { }
                }
            }
        }
    }
}
