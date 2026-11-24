using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace LangLinkMemoQBridgeHelper
{
    internal static class PluginAssetDownloader
    {
        private const string PluginDllName = "MemoQ.AI.Hub.Plugin.dll";
        private const int MaxDownloadBytes = 200 * 1024 * 1024;
        private const int MaxDllBytes = 50 * 1024 * 1024;
        private const int MaxRedirects = 5;
        private const int RequestTimeoutMs = 30000;

        static PluginAssetDownloader()
        {
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                try
                {
                    ServicePointManager.SecurityProtocol |= (SecurityProtocolType)12288;
                }
                catch
                {
                }
            }
            catch
            {
            }
        }

        public static Dictionary<string, object> DownloadPluginDll(
            string rawUrl,
            string outputPath,
            string expectedSha256Csv)
        {
            if (string.IsNullOrWhiteSpace(outputPath))
            {
                throw new ArgumentException("Missing required argument: --out");
            }

            var uri = ValidateAllowedUrl(rawUrl);
            var expectedShas = ParseExpectedShaList(expectedSha256Csv);
            var fullOutput = Path.GetFullPath(outputPath.Trim());

            byte[] dllBytes = null;
            var method = "full";

            var rangeResult = TryDownloadViaHttpRange(uri);
            if (rangeResult != null)
            {
                dllBytes = rangeResult;
                method = "range-zip";
            }
            else
            {
                var fullBytes = DownloadFullBytes(uri, MaxDownloadBytes);
                if (IsZip(fullBytes))
                {
                    dllBytes = ExtractPluginDllFromZipBytes(fullBytes);
                    method = "full-zip";
                }
                else
                {
                    dllBytes = fullBytes;
                    method = "full-dll";
                }
            }

            if (dllBytes == null || dllBytes.Length < 2 || dllBytes[0] != 0x4D || dllBytes[1] != 0x5A)
            {
                throw new InvalidDataException($"Downloaded artifact is not a valid PE DLL ({PluginDllName}).");
            }

            var actualSha256 = WriteAtomicFile(fullOutput, dllBytes, expectedShas);

            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["action"] = "fetch-plugin-dll",
                ["outPath"] = fullOutput,
                ["sha256"] = actualSha256,
                ["bytes"] = dllBytes.Length,
                ["method"] = method
            };
        }

        private static bool IsLoopbackHost(string host)
        {
            return host == "127.0.0.1" || host == "localhost" || host == "::1";
        }

        private static Uri ValidateAllowedUrl(string rawUrl, bool allowLoopback = true)
        {
            if (string.IsNullOrWhiteSpace(rawUrl))
            {
                throw new ArgumentException("Plugin DLL download URL is empty.");
            }
            if (!Uri.TryCreate(rawUrl.Trim(), UriKind.Absolute, out var uri))
            {
                throw new ArgumentException("Plugin DLL download URL is not a valid URL.");
            }
            var scheme = uri.Scheme.ToLowerInvariant();
            if (scheme != "https" && scheme != "http")
            {
                throw new ArgumentException("Plugin DLL download URL must use https or loopback http.");
            }
            var host = uri.Host.Trim('[', ']').ToLowerInvariant();
            var isLoopback = IsLoopbackHost(host);
            if (!allowLoopback && isLoopback)
            {
                throw new ArgumentException("External plugin DLL download URL must not redirect to loopback.");
            }
            if (scheme == "http" && !isLoopback)
            {
                throw new ArgumentException("Plugin DLL download URL must use https unless it points at loopback.");
            }
            if (!string.IsNullOrEmpty(uri.UserInfo))
            {
                throw new ArgumentException("Plugin DLL download URL must not embed credentials.");
            }
            return uri;
        }

        private static HashSet<string> ParseExpectedShaList(string csv)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrWhiteSpace(csv))
            {
                return set;
            }
            foreach (var part in csv.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var trimmed = part.Trim().ToUpperInvariant();
                if (!string.IsNullOrEmpty(trimmed))
                {
                    set.Add(trimmed);
                }
            }
            return set;
        }

        private static HttpWebRequest CreateRequest(Uri uri, string method)
        {
            var req = (HttpWebRequest)WebRequest.Create(uri);
            req.Method = method;
            req.AllowAutoRedirect = false;
            req.AutomaticDecompression = DecompressionMethods.None;
            req.Timeout = RequestTimeoutMs;
            req.ReadWriteTimeout = RequestTimeoutMs;
            req.UserAgent = "LangLink-memoQ-Bridge/1.0";
            return req;
        }

        private static bool IsRedirectStatus(int statusCode)
        {
            return statusCode == 301 || statusCode == 302 || statusCode == 303 || statusCode == 307 || statusCode == 308;
        }

        private static HttpWebResponse SendFollowingValidatedRedirects(
            Uri initialUri,
            string method,
            Action<HttpWebRequest> configureRequest,
            out Uri finalUri)
        {
            var initialHost = initialUri.Host.Trim('[', ']').ToLowerInvariant();
            var allowLoopback = IsLoopbackHost(initialHost);
            var currentUri = ValidateAllowedUrl(initialUri.AbsoluteUri, true);

            for (var hop = 0; hop <= MaxRedirects; hop++)
            {
                var req = CreateRequest(currentUri, method);
                if (configureRequest != null)
                {
                    configureRequest(req);
                }

                HttpWebResponse resp = null;
                try
                {
                    resp = (HttpWebResponse)req.GetResponse();
                }
                catch (WebException ex)
                {
                    var errResp = ex.Response as HttpWebResponse;
                    if (errResp == null || !IsRedirectStatus((int)errResp.StatusCode))
                    {
                        throw;
                    }
                    resp = errResp;
                }

                var code = (int)resp.StatusCode;
                if (IsRedirectStatus(code))
                {
                    var location = resp.Headers["Location"];
                    resp.Dispose();
                    if (hop >= MaxRedirects)
                    {
                        throw new IOException($"Exceeded maximum redirect limit ({MaxRedirects}).");
                    }
                    if (string.IsNullOrWhiteSpace(location))
                    {
                        throw new IOException($"Redirect response ({code}) missing Location header.");
                    }
                    var nextUri = new Uri(currentUri, location);
                    currentUri = ValidateAllowedUrl(nextUri.AbsoluteUri, allowLoopback);
                    continue;
                }

                if (resp.ResponseUri != null)
                {
                    ValidateAllowedUrl(resp.ResponseUri.AbsoluteUri, allowLoopback);
                }
                finalUri = currentUri;
                return resp;
            }

            throw new IOException($"Exceeded maximum redirect limit ({MaxRedirects}).");
        }

        private static byte[] TryDownloadViaHttpRange(Uri initialUri)
        {
            Uri finalUri;
            long totalLength;
            string acceptRanges;

            try
            {
                using (var headResp = SendFollowingValidatedRedirects(initialUri, "HEAD", null, out finalUri))
                {
                    totalLength = headResp.ContentLength;
                    acceptRanges = headResp.Headers["Accept-Ranges"] ?? string.Empty;
                }
            }
            catch (ArgumentException)
            {
                throw;
            }
            catch
            {
                return null;
            }

            if (totalLength <= 22 || acceptRanges.IndexOf("bytes", StringComparison.OrdinalIgnoreCase) < 0)
            {
                return null;
            }

            var tailSize = (int)Math.Min(65536L, totalLength);
            var tailStart = totalLength - tailSize;
            var tail = FetchRange(finalUri, tailStart, totalLength - 1);
            if (tail == null)
            {
                return null;
            }

            var eocdPos = FindSignatureFromEnd(tail, 0x50, 0x4B, 0x05, 0x06);
            if (eocdPos < 0 || eocdPos + 22 > tail.Length)
            {
                return null;
            }

            var cdSize = (long)ReadUInt32LE(tail, eocdPos + 12);
            var cdOffset = (long)ReadUInt32LE(tail, eocdPos + 16);

            if (cdSize == 0xFFFFFFFFL || cdOffset == 0xFFFFFFFFL)
            {
                var locPos = eocdPos - 20;
                if (locPos < 0 || !MatchSig(tail, locPos, 0x50, 0x4B, 0x06, 0x07))
                {
                    return null;
                }
                var eocd64Offset = ReadInt64LE(tail, locPos + 8);
                var eocd64 = FetchRange(finalUri, eocd64Offset, Math.Min(totalLength - 1, eocd64Offset + 55));
                if (eocd64 == null || eocd64.Length < 56 || !MatchSig(eocd64, 0, 0x50, 0x4B, 0x06, 0x06))
                {
                    return null;
                }
                cdSize = ReadInt64LE(eocd64, 40);
                cdOffset = ReadInt64LE(eocd64, 48);
            }

            if (cdSize <= 0 || cdSize > 32 * 1024 * 1024 || cdOffset < 0 || cdOffset + cdSize > totalLength)
            {
                return null;
            }

            byte[] cd;
            if (cdOffset >= tailStart && cdOffset + cdSize <= totalLength)
            {
                var rel = (int)(cdOffset - tailStart);
                cd = new byte[(int)cdSize];
                Buffer.BlockCopy(tail, rel, cd, 0, (int)cdSize);
            }
            else
            {
                cd = FetchRange(finalUri, cdOffset, cdOffset + cdSize - 1);
            }

            if (cd == null || !TryFindPluginEntryInCentralDirectory(cd, out var entry))
            {
                return null;
            }

            if (entry.CompressedSize < 0 || entry.CompressedSize > 50 * 1024 * 1024)
            {
                return null;
            }

            var probeEnd = Math.Min(totalLength - 1, entry.LocalHeaderOffset + 30 + entry.FileNameLength + 1024 + entry.CompressedSize - 1);
            var localChunk = FetchRange(finalUri, entry.LocalHeaderOffset, probeEnd);
            if (localChunk == null || localChunk.Length < 30 || !MatchSig(localChunk, 0, 0x50, 0x4B, 0x03, 0x04))
            {
                return null;
            }

            var lhNameLen = ReadUInt16LE(localChunk, 26);
            var lhExtraLen = ReadUInt16LE(localChunk, 28);
            var dataOffsetInLocal = 30 + lhNameLen + lhExtraLen;
            var neededLength = dataOffsetInLocal + (int)entry.CompressedSize;

            if (neededLength > localChunk.Length)
            {
                var exactEnd = entry.LocalHeaderOffset + neededLength - 1;
                if (exactEnd >= totalLength)
                {
                    return null;
                }
                localChunk = FetchRange(finalUri, entry.LocalHeaderOffset, exactEnd);
                if (localChunk == null || localChunk.Length < neededLength)
                {
                    return null;
                }
            }

            return DecompressZipEntryData(localChunk, dataOffsetInLocal, (int)entry.CompressedSize, entry.CompressionMethod, entry.UncompressedSize);
        }

        private static byte[] FetchRange(Uri uri, long start, long end)
        {
            if (start < 0 || end < start)
            {
                return null;
            }
            try
            {
                using (var resp = SendFollowingValidatedRedirects(uri, "GET", req => req.AddRange(start, end), out _))
                {
                    if ((int)resp.StatusCode != 206)
                    {
                        return null;
                    }
                    using (var stream = resp.GetResponseStream())
                    {
                        if (stream == null)
                        {
                            return null;
                        }
                        var maxExpected = (int)Math.Min(MaxDownloadBytes, (end - start + 1) + 1024);
                        return ReadAllBounded(stream, maxExpected);
                    }
                }
            }
            catch (ArgumentException)
            {
                throw;
            }
            catch
            {
                return null;
            }
        }

        private static byte[] DownloadFullBytes(Uri uri, int maxBytes)
        {
            using (var resp = SendFollowingValidatedRedirects(uri, "GET", null, out _))
            {
                var status = (int)resp.StatusCode;
                if (status < 200 || status >= 300)
                {
                    throw new IOException($"Failed to download {PluginDllName} ({status} {resp.StatusDescription}).");
                }
                using (var stream = resp.GetResponseStream())
                {
                    if (stream == null)
                    {
                        throw new IOException("Empty HTTP response stream.");
                    }
                    return ReadAllBounded(stream, maxBytes);
                }
            }
        }

        private static byte[] ExtractPluginDllFromZipBytes(byte[] zipBytes)
        {
            var eocdPos = FindSignatureFromEnd(zipBytes, 0x50, 0x4B, 0x05, 0x06);
            if (eocdPos < 0 || eocdPos + 22 > zipBytes.Length)
            {
                throw new InvalidDataException($"ZIP EOCD header not found while extracting {PluginDllName}.");
            }

            var cdSize = (long)ReadUInt32LE(zipBytes, eocdPos + 12);
            var cdOffset = (long)ReadUInt32LE(zipBytes, eocdPos + 16);
            if (cdSize == 0xFFFFFFFFL || cdOffset == 0xFFFFFFFFL)
            {
                var locPos = eocdPos - 20;
                if (locPos < 0 || !MatchSig(zipBytes, locPos, 0x50, 0x4B, 0x06, 0x07))
                {
                    throw new InvalidDataException("Unsupported ZIP64 archive structure.");
                }
                var eocd64Offset = ReadInt64LE(zipBytes, locPos + 8);
                if (eocd64Offset < 0 || eocd64Offset + 56 > zipBytes.Length)
                {
                    throw new InvalidDataException("Invalid ZIP64 EOCD offset.");
                }
                cdSize = ReadInt64LE(zipBytes, (int)eocd64Offset + 40);
                cdOffset = ReadInt64LE(zipBytes, (int)eocd64Offset + 48);
            }

            if (cdSize <= 0 || cdOffset < 0 || cdOffset + cdSize > zipBytes.Length)
            {
                throw new InvalidDataException("Invalid ZIP Central Directory bounds.");
            }

            var cd = new byte[(int)cdSize];
            Buffer.BlockCopy(zipBytes, (int)cdOffset, cd, 0, (int)cdSize);
            if (!TryFindPluginEntryInCentralDirectory(cd, out var entry))
            {
                throw new InvalidDataException($"Archive did not contain {PluginDllName}.");
            }

            var localOffset = (int)entry.LocalHeaderOffset;
            if (localOffset < 0 || localOffset + 30 > zipBytes.Length || !MatchSig(zipBytes, localOffset, 0x50, 0x4B, 0x03, 0x04))
            {
                throw new InvalidDataException("Invalid ZIP local file header.");
            }
            var lhNameLen = ReadUInt16LE(zipBytes, localOffset + 26);
            var lhExtraLen = ReadUInt16LE(zipBytes, localOffset + 28);
            var dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
            if (dataStart + entry.CompressedSize > zipBytes.Length)
            {
                throw new InvalidDataException("Truncated ZIP entry payload.");
            }
            return DecompressZipEntryData(zipBytes, dataStart, (int)entry.CompressedSize, entry.CompressionMethod, entry.UncompressedSize);
        }

        private struct ZipEntryInfo
        {
            public int CompressionMethod;
            public long CompressedSize;
            public long UncompressedSize;
            public int FileNameLength;
            public long LocalHeaderOffset;
        }

        private static bool TryFindPluginEntryInCentralDirectory(byte[] cd, out ZipEntryInfo found)
        {
            found = default(ZipEntryInfo);
            var pos = 0;
            while (pos + 46 <= cd.Length)
            {
                if (!MatchSig(cd, pos, 0x50, 0x4B, 0x01, 0x02))
                {
                    break;
                }
                var compMethod = ReadUInt16LE(cd, pos + 10);
                var compSize = (long)ReadUInt32LE(cd, pos + 20);
                var uncompSize = (long)ReadUInt32LE(cd, pos + 24);
                var nameLen = ReadUInt16LE(cd, pos + 28);
                var extraLen = ReadUInt16LE(cd, pos + 30);
                var commentLen = ReadUInt16LE(cd, pos + 32);
                var localOffset = (long)ReadUInt32LE(cd, pos + 42);

                if (pos + 46 + nameLen + extraLen + commentLen > cd.Length)
                {
                    break;
                }

                var rawName = Encoding.UTF8.GetString(cd, pos + 46, nameLen).Replace('\\', '/').ToLowerInvariant();
                var targetLower = PluginDllName.ToLowerInvariant();
                if (rawName == targetLower || rawName.EndsWith("/" + targetLower, StringComparison.Ordinal))
                {
                    if (uncompSize == 0xFFFFFFFFL || compSize == 0xFFFFFFFFL || localOffset == 0xFFFFFFFFL)
                    {
                        var extraPos = pos + 46 + nameLen;
                        var extraEnd = extraPos + extraLen;
                        while (extraPos + 4 <= extraEnd)
                        {
                            var headerId = ReadUInt16LE(cd, extraPos);
                            var fieldSize = ReadUInt16LE(cd, extraPos + 2);
                            var fieldData = extraPos + 4;
                            if (fieldData + fieldSize > extraEnd)
                            {
                                break;
                            }
                            if (headerId == 0x0001)
                            {
                                var cursor = fieldData;
                                if (uncompSize == 0xFFFFFFFFL && cursor + 8 <= fieldData + fieldSize)
                                {
                                    uncompSize = ReadInt64LE(cd, cursor);
                                    cursor += 8;
                                }
                                if (compSize == 0xFFFFFFFFL && cursor + 8 <= fieldData + fieldSize)
                                {
                                    compSize = ReadInt64LE(cd, cursor);
                                    cursor += 8;
                                }
                                if (localOffset == 0xFFFFFFFFL && cursor + 8 <= fieldData + fieldSize)
                                {
                                    localOffset = ReadInt64LE(cd, cursor);
                                }
                                break;
                            }
                            extraPos = fieldData + fieldSize;
                        }
                    }

                    found = new ZipEntryInfo
                    {
                        CompressionMethod = compMethod,
                        CompressedSize = compSize,
                        UncompressedSize = uncompSize,
                        FileNameLength = nameLen,
                        LocalHeaderOffset = localOffset
                    };
                    return true;
                }

                pos += 46 + nameLen + extraLen + commentLen;
            }
            return false;
        }

        private static byte[] DecompressZipEntryData(
            byte[] buffer,
            int offset,
            int compressedSize,
            int compressionMethod,
            long uncompressedSize)
        {
            if (compressedSize < 0 || compressedSize > MaxDllBytes || uncompressedSize > MaxDllBytes)
            {
                throw new InvalidDataException($"ZIP entry size exceeds allowed limit ({MaxDllBytes} bytes).");
            }
            if (compressionMethod == 0)
            {
                var exact = new byte[compressedSize];
                Buffer.BlockCopy(buffer, offset, exact, 0, compressedSize);
                return exact;
            }
            if (compressionMethod == 8)
            {
                using (var compressedStream = new MemoryStream(buffer, offset, compressedSize, false))
                using (var deflate = new DeflateStream(compressedStream, CompressionMode.Decompress))
                {
                    return ReadAllBounded(deflate, MaxDllBytes);
                }
            }
            throw new NotSupportedException($"Unsupported ZIP compression method: {compressionMethod}.");
        }

        private static byte[] ReadAllBounded(Stream stream, int maxBytes)
        {
            using (var ms = new MemoryStream())
            {
                var buffer = new byte[65536];
                var total = 0;
                int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    total += read;
                    if (total > maxBytes)
                    {
                        throw new InvalidDataException($"Download exceeded maximum size limit ({maxBytes} bytes).");
                    }
                    ms.Write(buffer, 0, read);
                }
                return ms.ToArray();
            }
        }

        private static bool IsZip(byte[] bytes)
        {
            return bytes != null && bytes.Length >= 2 && bytes[0] == 0x50 && bytes[1] == 0x4B;
        }

        private static int FindSignatureFromEnd(byte[] bytes, byte b0, byte b1, byte b2, byte b3)
        {
            if (bytes == null || bytes.Length < 4)
            {
                return -1;
            }
            var minIndex = Math.Max(0, bytes.Length - 65560);
            for (var i = bytes.Length - 4; i >= minIndex; i--)
            {
                if (bytes[i] == b0 && bytes[i + 1] == b1 && bytes[i + 2] == b2 && bytes[i + 3] == b3)
                {
                    return i;
                }
            }
            return -1;
        }

        private static bool MatchSig(byte[] bytes, int pos, byte b0, byte b1, byte b2, byte b3)
        {
            return pos >= 0 && pos + 3 < bytes.Length
                && bytes[pos] == b0 && bytes[pos + 1] == b1 && bytes[pos + 2] == b2 && bytes[pos + 3] == b3;
        }

        private static int ReadUInt16LE(byte[] bytes, int pos)
        {
            return bytes[pos] | (bytes[pos + 1] << 8);
        }

        private static uint ReadUInt32LE(byte[] bytes, int pos)
        {
            return (uint)(bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24));
        }

        private static long ReadInt64LE(byte[] bytes, int pos)
        {
            var lo = (long)ReadUInt32LE(bytes, pos);
            var hi = (long)ReadUInt32LE(bytes, pos + 4);
            return lo | (hi << 32);
        }

        private static string ComputeSha256Upper(Stream stream)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(stream);
                var sb = new StringBuilder(hash.Length * 2);
                foreach (var b in hash)
                {
                    sb.Append(b.ToString("X2"));
                }
                return sb.ToString();
            }
        }

        private static string WriteAtomicFile(string targetPath, byte[] bytes, HashSet<string> expectedShas)
        {
            var dir = Path.GetDirectoryName(targetPath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            var tempPath = targetPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllBytes(tempPath, bytes);
                string actualSha256;
                using (var stagedFile = File.OpenRead(tempPath))
                {
                    actualSha256 = ComputeSha256Upper(stagedFile);
                }
                if (expectedShas.Count > 0 && !expectedShas.Contains(actualSha256))
                {
                    throw new InvalidDataException(
                        $"Plugin DLL SHA-256 mismatch. Expected {string.Join(" or ", expectedShas)}, actual {actualSha256}.");
                }

                if (File.Exists(targetPath))
                {
                    File.Replace(tempPath, targetPath, null);
                }
                else
                {
                    File.Move(tempPath, targetPath);
                }
                return actualSha256;
            }
            finally
            {
                if (File.Exists(tempPath))
                {
                    try { File.Delete(tempPath); } catch { }
                }
            }
        }
    }
}
