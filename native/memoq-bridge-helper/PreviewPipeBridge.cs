using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace LangLinkMemoQBridgeHelper
{
    internal sealed class PreviewPipeBridge
    {
        private const string PipeBaseName = "MQ_PREVIEW_PIPE";
        private static readonly Guid DefaultPreviewToolId = new Guid("7f4e9b21-8c34-4a62-9d51-3b7e2f8a6c14");
        private const string DefaultPreviewToolName = "LangLink memoQ Bridge Preview";
        private const string PreviewToolDescription = "Connects memoQ active preview context to LangLink MCP and DSH agents.";
        private const string PreviewPartIdRegex = ".*";
        private const string PreviewContentComplexity = "Minimal";

        private readonly Guid _previewToolId;
        private readonly string _previewToolName;
        private readonly JavaScriptSerializer _serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly object _stdoutLock = new object();
        private readonly object _pipeSync = new object();
        private readonly Dictionary<string, PendingResponse> _pendingResponses = new Dictionary<string, PendingResponse>(StringComparer.OrdinalIgnoreCase);

        private volatile bool _stopping;
        private volatile string _activePartKey;
        private volatile string _cancelledOperation;
        private PipeTransport _activePipe;

        public PreviewPipeBridge(string toolIdOverride, string toolNameOverride)
        {
            _previewToolId = !string.IsNullOrWhiteSpace(toolIdOverride) && Guid.TryParse(toolIdOverride, out var parsed)
                ? parsed
                : DefaultPreviewToolId;
            _previewToolName = string.IsNullOrWhiteSpace(toolNameOverride)
                ? DefaultPreviewToolName
                : toolNameOverride.Trim();
        }

        public void Run()
        {
            var stdinThread = new Thread(ReadStdinLoop)
            {
                IsBackground = true,
                Name = "MemoQBridgeStdinReader"
            };
            stdinThread.Start();

            EmitStatus("starting", connected: false, error: string.Empty);

            while (!_stopping)
            {
                try
                {
                    ConnectAndPump();
                }
                catch (Exception error)
                {
                    if (_stopping)
                    {
                        break;
                    }
                    EmitStatus("error", connected: false, error: error.Message);
                }

                for (var elapsed = 0; elapsed < 3000 && !_stopping; elapsed += 100)
                {
                    Thread.Sleep(100);
                }
            }

            EmitStatus("stopped", connected: false, error: string.Empty);
        }

        private void ConnectAndPump()
        {
            _activePartKey = null;
            EmitStatus("connecting", connected: false, error: string.Empty);

            using (var pipe = new PipeTransport(PipeBaseName, _serializer))
            {
                lock (_pipeSync)
                {
                    if (_stopping)
                    {
                        return;
                    }
                    _activePipe = pipe;
                }

                try
                {
                    pipe.MessageReceived += HandlePipeMessage;
                    pipe.Connect();
                    pipe.StartReading();

                    var negotiation = SendCommandAndWait(
                        pipe,
                        "negotiation-request",
                        new Dictionary<string, object>
                        {
                            ["KnownProtocolVersions"] = new[] { "V1" }
                        },
                        "negotiation-request",
                        5000
                    );

                    var protocolVersion = negotiation.GetValue("ProtocolVersion");
                    if (string.IsNullOrWhiteSpace(protocolVersion))
                    {
                        throw new InvalidOperationException("memoQ preview negotiation failed.");
                    }

                    var existingConnection = SendCommandAndWait(pipe, "connection-request",
                        new Dictionary<string, object> { ["PreviewToolId"] = _previewToolId.ToString() },
                        "connection-request", 5000);
                    if (!existingConnection.Accepted)
                    {
                        var registrationResponse = SendCommandAndWait(
                            pipe,
                            "registration-request",
                            new Dictionary<string, object>
                            {
                                ["PreviewToolId"] = _previewToolId.ToString(),
                                ["PreviewToolName"] = _previewToolName,
                                ["PreviewToolDescription"] = PreviewToolDescription,
                                ["PreviewPartIdRegex"] = PreviewPartIdRegex,
                                ["RequiresWebPreviewBaseUrl"] = false,
                                ["ContentComplexity"] = PreviewContentComplexity,
                                ["RequiredProperties"] = new string[0]
                            },
                            "registration-request",
                            5000
                        );

                        if (!registrationResponse.Accepted)
                            throw new InvalidOperationException(registrationResponse.ErrorMessage ?? "memoQ refused registration.");
                    }

                    var runtimeSettingsResponse = SendCommandAndWait(
                        pipe,
                        "change-runtime-settings-request",
                        new Dictionary<string, object>
                        {
                            ["PreviewToolId"] = _previewToolId.ToString(),
                            ["ContentComplexity"] = PreviewContentComplexity,
                            ["RequiredProperties"] = new string[0]
                        },
                        "change-runtime-settings-request",
                        5000
                    );

                    if (!runtimeSettingsResponse.Accepted)
                    {
                        throw new InvalidOperationException(runtimeSettingsResponse.ErrorMessage ?? "memoQ preview runtime settings change was refused.");
                    }

                    EmitStatus("connected", connected: true, error: string.Empty, memoQVersion: GetServerVersion(pipe.ServerProcessId));
                    SendRefreshParts(pipe);
                    pipe.WaitUntilClosed();
                }
                finally
                {
                    lock (_pipeSync)
                    {
                        if (ReferenceEquals(_activePipe, pipe))
                        {
                            _activePipe = null;
                        }
                    }
                }
            }

            if (!_stopping)
            {
                EmitStatus("disconnected", connected: false, error: string.Empty);
            }
        }

        private void ReadStdinLoop()
        {
            try
            {
                using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                {
                    string line;
                    while (!_stopping && (line = reader.ReadLine()) != null)
                    {
                        if (string.IsNullOrWhiteSpace(line))
                        {
                            continue;
                        }

                        HandleStdinCommand(line);
                    }
                }
            }
            catch
            {
                // Parent closed stdin; shut down cleanly.
            }
            finally
            {
                InitiateStop();
            }
        }

        private void HandleStdinCommand(string rawJson)
        {
            string id = string.Empty;
            try
            {
                var command = _serializer.DeserializeObject(rawJson) as IDictionary<string, object>;
                if (command == null)
                {
                    return;
                }

                id = ReadString(command, "id");
                var type = ReadString(command, "type");

                if (string.Equals(type, "shutdown", StringComparison.OrdinalIgnoreCase))
                {
                    EmitAck(id, ok: true, error: string.Empty);
                    InitiateStop();
                    return;
                }

                PipeTransport pipe;
                lock (_pipeSync)
                {
                    pipe = _activePipe;
                }

                if (pipe == null)
                {
                    EmitAck(id, ok: false, error: "memoQ preview pipe is not connected.");
                    return;
                }

                if (type == "cancel_edit")
                {
                    _cancelledOperation = ReadString(command, "operationId");
                    EmitAck(id, true, "");
                    return;
                }
                if (type == "read_part")
                {
                    pipe.Send("content-update-request-from-preview-tool", new Dictionary<string, object>
                    {
                        ["PreviewToolId"] = _previewToolId.ToString(),
                        ["PreviewPartIds"] = new[] { ReadString(command, "previewPartId") }
                    });
                    EmitAck(id, true, "");
                    return;
                }
                if (type == "activate_editor")
                {
                    var key = ReadString(command, "documentId") + "/" + ReadString(command, "previewPartId");
                    var result = DesktopEditor.WithEditor(pipe.ServerProcessId, () => DesktopEditor.Activate(Convert.ToInt32(command["row"]), _activePartKey != key));
                    EmitAck(id, result == null, result);
                    return;
                }
                if (type == "inspect_target")
                {
                    var key = ReadString(command, "documentId") + "/" + ReadString(command, "previewPartId");
                    var actual = DesktopEditor.WithEditor(pipe.ServerProcessId, () => DesktopEditor.Inspect(Convert.ToInt32(command["row"]), Convert.ToBoolean(command["mayBeEmpty"]), () => _activePartKey == key));
                    EmitJson(new Dictionary<string,object> { ["type"]="ack", ["id"]=id, ["ok"]=true, ["actualTarget"]=actual });
                    return;
                }
                if (type == "replace_text")
                {
                    var key = ReadString(command, "documentId") + "/" + ReadString(command, "previewPartId");
                    var operationId = ReadString(command, "operationId");
                    var expiresAt = Convert.ToInt64(command["expiresAt"]);
                    // Leave the stdin reader available for cancellation during an edit.
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        try
                        {
                            var result = DesktopEditor.WithEditor(pipe.ServerProcessId, () => DesktopEditor.Replace(
                                Convert.ToInt32(command["row"]), ReadString(command, "expectedTarget"),
                                ReadString(command, "oldText"), ReadString(command, "newText"),
                                Convert.ToInt32(command["start"]), () => !_stopping && _activePartKey == key &&
                                _cancelledOperation != operationId && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < expiresAt));
                            EmitAck(id, result == null, result);
                        }
                        catch (Exception error) { EmitAck(id, false, error.Message); }
                    });
                    return;
                }

                if (string.Equals(type, "refresh_parts", StringComparison.OrdinalIgnoreCase))
                {
                    SendRefreshParts(pipe);
                    EmitAck(id, ok: true, error: string.Empty);
                    return;
                }

                if (string.Equals(type, "focus_segment", StringComparison.OrdinalIgnoreCase))
                {
                    var previewPartId = ReadString(command, "previewPartId");
                    if (string.IsNullOrWhiteSpace(previewPartId))
                    {
                        EmitAck(id, ok: false, error: "previewPartId is required.");
                        return;
                    }

                    var parameters = new Dictionary<string, object>
                    {
                        ["PreviewToolId"] = _previewToolId.ToString(),
                        ["PreviewPartId"] = previewPartId
                    };

                    var sourceLangCode = ReadString(command, "sourceLangCode");
                    if (!string.IsNullOrWhiteSpace(sourceLangCode))
                    {
                        parameters["SourceLangCode"] = sourceLangCode;
                    }

                    var targetLangCode = ReadString(command, "targetLangCode");
                    if (!string.IsNullOrWhiteSpace(targetLangCode))
                    {
                        parameters["TargetLangCode"] = targetLangCode;
                    }

                    var sourceContent = ReadString(command, "sourceContent");
                    if (!string.IsNullOrEmpty(sourceContent))
                    {
                        parameters["SourceContent"] = sourceContent;
                    }

                    var targetContent = ReadString(command, "targetContent");
                    if (!string.IsNullOrEmpty(targetContent))
                    {
                        parameters["TargetContent"] = targetContent;
                    }

                    var sourceRange = BuildFocusedRange(ReadDictionary(command, "sourceFocusedRange"));
                    if (sourceRange != null)
                    {
                        parameters["SourceFocusedRange"] = sourceRange;
                    }

                    var targetRange = BuildFocusedRange(ReadDictionary(command, "targetFocusedRange"));
                    if (targetRange != null)
                    {
                        parameters["TargetFocusedRange"] = targetRange;
                    }

                    var response = SendCommandAndWait(
                        pipe,
                        "change-highlight-request-from-preview-tool",
                        parameters,
                        "change-highlight-request-from-preview-tool",
                        3000
                    );

                    EmitAck(id, ok: response.Accepted, error: response.Accepted ? string.Empty : (response.ErrorMessage ?? "memoQ refused focus request."));
                    return;
                }

                EmitAck(id, ok: false, error: $"Unsupported bridge helper command: {type}");
            }
            catch (Exception error)
            {
                EmitAck(id, ok: false, error: error.Message);
            }
        }

        private void InitiateStop()
        {
            _stopping = true;
            PipeTransport pipe;
            lock (_pipeSync)
            {
                pipe = _activePipe;
            }
            if (pipe != null)
            {
                try { pipe.Dispose(); } catch { }
            }
        }

        private void SendRefreshParts(PipeTransport pipe)
        {
            pipe.Send(
                "preview-part-id-update-request-from-preview-tool",
                new Dictionary<string, object>
                {
                    ["PreviewToolId"] = _previewToolId.ToString()
                }
            );
        }

        private PendingResponse SendCommandAndWait(
            PipeTransport pipe,
            string commandType,
            Dictionary<string, object> parameters,
            string responseKey,
            int timeoutMs)
        {
            PendingResponse pending;
            lock (_pendingResponses)
            {
                pending = new PendingResponse(responseKey);
                _pendingResponses[responseKey] = pending;
            }

            try
            {
                pipe.Send(commandType, parameters);
                if (!pending.WaitHandle.WaitOne(timeoutMs))
                {
                    throw new TimeoutException($"Timed out while waiting for preview response: {responseKey}");
                }
                return pending;
            }
            finally
            {
                lock (_pendingResponses)
                {
                    _pendingResponses.Remove(responseKey);
                }
            }
        }

        private void HandlePipeMessage(object sender, PipeMessageEventArgs eventArgs)
        {
            var commandType = eventArgs.CommandType;
            var parameters = eventArgs.CommandParameters;

            if (string.Equals(commandType, "request-accepted", StringComparison.OrdinalIgnoreCase))
            {
                ResolvePending(ReadString(parameters, "CommandType"), accepted: true, parameters, string.Empty, string.Empty);
                return;
            }

            if (string.Equals(commandType, "request-refused", StringComparison.OrdinalIgnoreCase))
            {
                ResolvePending(
                    ReadString(parameters, "CommandType"),
                    accepted: false,
                    parameters,
                    ReadString(parameters, "ErrorCode"),
                    ReadString(parameters, "ErrorMessage")
                );
                return;
            }

            if (string.Equals(commandType, "invalid-request", StringComparison.OrdinalIgnoreCase))
            {
                var originalRequest = ReadDictionary(parameters, "OriginalRequest");
                ResolvePending(
                    ReadString(originalRequest, "CommandType"),
                    accepted: false,
                    parameters,
                    "InvalidRequestParameters",
                    ReadString(parameters, "ErrorMessage")
                );
                return;
            }

            if (string.Equals(commandType, "negotiation-response", StringComparison.OrdinalIgnoreCase))
            {
                ResolvePending("negotiation-request", accepted: true, parameters, string.Empty, string.Empty);
                return;
            }

            if (string.Equals(commandType, "preview-part-id-update-request-from-mq", StringComparison.OrdinalIgnoreCase))
            {
                var previewPartIds = ReadArray(parameters, "PreviewPartIds")
                    .Select(item => Convert.ToString(item) ?? string.Empty)
                    .Where(item => !string.IsNullOrWhiteSpace(item))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();

                EmitJson(new Dictionary<string, object>
                {
                    ["type"] = "part_ids",
                    ["previewPartIds"] = previewPartIds
                });

                if (previewPartIds.Length > 0 && sender is PipeTransport pipe)
                {
                    try
                    {
                        pipe.Send(
                            "content-update-request-from-preview-tool",
                            new Dictionary<string, object>
                            {
                                ["PreviewToolId"] = _previewToolId.ToString(),
                                ["PreviewPartIds"] = previewPartIds
                            }
                        );
                    }
                    catch
                    {
                    }
                }
                return;
            }

            if (string.Equals(commandType, "content-update-request-from-mq", StringComparison.OrdinalIgnoreCase))
            {
                var rawParts = ReadArray(parameters, "PreviewParts");
                var mapped = new List<Dictionary<string, object>>();
                for (var index = 0; index < rawParts.Length; index += 1)
                {
                    if (rawParts[index] is IDictionary<string, object> part)
                    {
                        var mappedPart = MapPreviewPart(part, index, includeRanges: false);
                        if (mappedPart != null)
                        {
                            mapped.Add(mappedPart);
                        }
                    }
                }

                if (mapped.Count > 0)
                {
                    EmitJson(new Dictionary<string, object>
                    {
                        ["type"] = "content_update",
                        ["parts"] = mapped.ToArray()
                    });
                }
                return;
            }

            if (string.Equals(commandType, "change-highlight-request-from-mq", StringComparison.OrdinalIgnoreCase))
            {
                var rawParts = ReadArray(parameters, "ActivePreviewParts");
                var mapped = new List<Dictionary<string, object>>();
                for (var index = 0; index < rawParts.Length; index += 1)
                {
                    if (rawParts[index] is IDictionary<string, object> part)
                    {
                        var mappedPart = MapPreviewPart(part, index, includeRanges: true);
                        if (mappedPart != null)
                        {
                            mapped.Add(mappedPart);
                        }
                    }
                }

                _activePartKey = mapped.Count == 1 ? mapped[0]["documentId"] + "/" + mapped[0]["previewPartId"] : null;
                EmitJson(new Dictionary<string, object>
                {
                    ["type"] = "highlight_change",
                    ["activeParts"] = mapped.ToArray()
                });
            }
        }

        private static Dictionary<string, object> MapPreviewPart(IDictionary<string, object> part, int order, bool includeRanges)
        {
            var sourceDocument = ReadDictionary(part, "SourceDocument");
            var documentId = ReadString(sourceDocument, "DocumentGuid");
            var previewPartId = ReadString(part, "PreviewPartId");
            if (string.IsNullOrWhiteSpace(documentId) && string.IsNullOrWhiteSpace(previewPartId))
            {
                return null;
            }

            var sourceContent = ReadDictionary(part, "SourceContent");
            var targetContent = ReadDictionary(part, "TargetContent");

            var mapped = new Dictionary<string, object>
            {
                ["documentId"] = documentId,
                ["documentName"] = ReadString(sourceDocument, "DocumentName"),
                ["importPath"] = ReadString(sourceDocument, "ImportPath"),
                ["sourceLanguage"] = ReadString(part, "SourceLangCode"),
                ["targetLanguage"] = ReadString(part, "TargetLangCode"),
                ["previewPartId"] = previewPartId,
                ["sourceText"] = ReadString(sourceContent, "Content"),
                ["targetText"] = ReadString(targetContent, "Content"),
                ["order"] = order
            };

            if (includeRanges)
            {
                if (!sourceContent.ContainsKey("Content")) mapped.Remove("sourceText");
                if (!targetContent.ContainsKey("Content")) mapped.Remove("targetText");
                mapped["sourceFocusedRange"] = ReadFocusedRange(part, "SourceFocusedRange");
                mapped["targetFocusedRange"] = ReadFocusedRange(part, "TargetFocusedRange");
            }

            return mapped;
        }

        private void ResolvePending(string key, bool accepted, IDictionary<string, object> parameters, string errorCode, string errorMessage)
        {
            if (string.IsNullOrWhiteSpace(key))
            {
                return;
            }

            PendingResponse pending;
            lock (_pendingResponses)
            {
                if (!_pendingResponses.TryGetValue(key, out pending))
                {
                    return;
                }
            }

            pending.Accepted = accepted;
            pending.Payload = CopyDictionary(parameters);
            pending.ErrorCode = errorCode;
            pending.ErrorMessage = errorMessage;
            pending.WaitHandle.Set();
        }

        private static string GetServerVersion(uint pid)
        {
            if (pid == 0) return null;
            try
            {
                using (var process = System.Diagnostics.Process.GetProcessById((int)pid))
                    return process.MainModule?.FileVersionInfo.FileVersion;
            }
            catch (System.ComponentModel.Win32Exception) { return null; }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
        }

        private void EmitStatus(string state, bool connected, string error, string memoQVersion = null)
        {
            EmitJson(new Dictionary<string, object>
            {
                ["type"] = "status",
                ["state"] = state ?? "idle",
                ["connected"] = connected,
                ["previewToolId"] = _previewToolId.ToString(),
                ["memoQVersion"] = memoQVersion,
                ["lastError"] = error ?? string.Empty,
                ["timestamp"] = DateTime.UtcNow.ToString("o")
            });
        }

        private void EmitAck(string id, bool ok, string error)
        {
            EmitJson(new Dictionary<string, object>
            {
                ["type"] = "ack",
                ["id"] = id ?? string.Empty,
                ["ok"] = ok,
                ["error"] = error ?? string.Empty
            });
        }

        private void EmitJson(Dictionary<string, object> payload)
        {
            var json = _serializer.Serialize(payload);
            lock (_stdoutLock)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }

        private static Dictionary<string, object> BuildFocusedRange(IDictionary<string, object> range)
        {
            if (range == null || range.Count == 0)
            {
                return null;
            }

            if (!TryReadInt(range, "startIndex", out var startIndex) && !TryReadInt(range, "StartIndex", out startIndex))
            {
                return null;
            }

            if (!TryReadInt(range, "length", out var length) && !TryReadInt(range, "Length", out length))
            {
                length = 0;
            }

            return new Dictionary<string, object>
            {
                ["StartIndex"] = Math.Max(0, startIndex),
                ["Length"] = Math.Max(0, length)
            };
        }

        private static Dictionary<string, object> ReadFocusedRange(IDictionary<string, object> source, string key)
        {
            var range = ReadDictionary(source, key);
            if (range.Count == 0)
            {
                return null;
            }

            if (!TryReadInt(range, "StartIndex", out var startIndex) && !TryReadInt(range, "startIndex", out startIndex))
            {
                return null;
            }

            if (!TryReadInt(range, "Length", out var length) && !TryReadInt(range, "length", out length))
            {
                return null;
            }

            return new Dictionary<string, object>
            {
                ["startIndex"] = startIndex,
                ["length"] = length
            };
        }

        private static bool IsAlreadyConnectedError(string errorCode)
        {
            var normalized = string.IsNullOrWhiteSpace(errorCode)
                ? string.Empty
                : new string(errorCode.Where(char.IsLetterOrDigit).ToArray());
            return string.Equals(normalized, "previewtoolalreadyconnectedwiththisid", StringComparison.OrdinalIgnoreCase);
        }

        private static IDictionary<string, object> CopyDictionary(IDictionary<string, object> source)
        {
            var copy = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            if (source == null)
            {
                return copy;
            }

            foreach (var pair in source)
            {
                copy[pair.Key] = pair.Value;
            }

            return copy;
        }

        private static IDictionary<string, object> ReadDictionary(IDictionary<string, object> source, string key)
        {
            if (source == null || !source.ContainsKey(key) || source[key] == null)
            {
                return new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            }

            if (source[key] is IDictionary<string, object> direct)
            {
                return direct;
            }

            return source[key] as Dictionary<string, object> ?? new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        }

        private static object[] ReadArray(IDictionary<string, object> source, string key)
        {
            if (source == null || !source.ContainsKey(key) || source[key] == null)
            {
                return new object[0];
            }

            return source[key] as object[] ?? new object[0];
        }

        private static string ReadString(IDictionary<string, object> source, string key)
        {
            if (source == null || !source.ContainsKey(key) || source[key] == null)
            {
                return string.Empty;
            }

            return Convert.ToString(source[key]) ?? string.Empty;
        }

        private static bool TryReadInt(IDictionary<string, object> source, string key, out int value)
        {
            value = 0;
            if (source == null || !source.ContainsKey(key) || source[key] == null)
            {
                return false;
            }

            try
            {
                value = Convert.ToInt32(source[key]);
                return true;
            }
            catch
            {
                return int.TryParse(Convert.ToString(source[key]), out value);
            }
        }
    }

    internal sealed class PipeTransport : IDisposable
    {
        private readonly string _pipeName;
        private readonly JavaScriptSerializer _serializer;
        private readonly ManualResetEventSlim _closedEvent = new ManualResetEventSlim(false);
        private readonly object _writeLock = new object();
        private NamedPipeClientStream _stream;

        public PipeTransport(string pipeName, JavaScriptSerializer serializer)
        {
            _pipeName = pipeName;
            _serializer = serializer;
        }

        public event EventHandler<PipeMessageEventArgs> MessageReceived;
        public uint ServerProcessId { get; private set; }
        [DllImport("kernel32.dll")]
        private static extern bool GetNamedPipeServerProcessId(SafePipeHandle handle, out uint processId);

        public void Connect()
        {
            _stream = new NamedPipeClientStream(
                ".",
                $"{_pipeName}_{Process.GetCurrentProcess().SessionId}",
                PipeDirection.InOut,
                PipeOptions.Asynchronous
            );

            _stream.Connect(2000);
            _stream.ReadMode = PipeTransmissionMode.Message;
            if (GetNamedPipeServerProcessId(_stream.SafePipeHandle, out var pid)) ServerProcessId = pid;
        }

        public void StartReading()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    while (_stream != null && _stream.IsConnected)
                    {
                        var data = ReadSingleMessage();
                        if (data == null || data.Length == 0)
                        {
                            break;
                        }

                        var json = Encoding.UTF8.GetString(data);
                        var payload = _serializer.DeserializeObject(json) as IDictionary<string, object>;
                        if (payload == null)
                        {
                            continue;
                        }

                        var commandType = payload.ContainsKey("CommandType") ? Convert.ToString(payload["CommandType"]) : string.Empty;
                        var commandParameters = payload.ContainsKey("CommandParameters")
                            ? payload["CommandParameters"] as IDictionary<string, object>
                            : null;

                        MessageReceived?.Invoke(this, new PipeMessageEventArgs(commandType, commandParameters ?? new Dictionary<string, object>()));
                    }
                }
                catch
                {
                }
                finally
                {
                    _closedEvent.Set();
                }
            });
        }

        public void Send(string commandType, IDictionary<string, object> commandParameters)
        {
            var payload = new Dictionary<string, object>
            {
                ["CommandType"] = commandType,
                ["CommandParameters"] = commandParameters ?? new Dictionary<string, object>()
            };

            var json = _serializer.Serialize(payload);
            var bytes = Encoding.UTF8.GetBytes(json);
            lock (_writeLock)
            {
                _stream.Write(bytes, 0, bytes.Length);
                _stream.Flush();
            }
        }

        public void WaitUntilClosed()
        {
            _closedEvent.Wait();
        }

        public void Dispose()
        {
            try { _stream?.Dispose(); } catch { }
            _closedEvent.Set();
        }

        private byte[] ReadSingleMessage()
        {
            using (var memory = new MemoryStream())
            {
                var buffer = new byte[4096];
                do
                {
                    var read = _stream.Read(buffer, 0, buffer.Length);
                    if (read == 0)
                    {
                        break;
                    }

                    memory.Write(buffer, 0, read);
                }
                while (!_stream.IsMessageComplete);

                return memory.ToArray();
            }
        }
    }

    internal sealed class PipeMessageEventArgs : EventArgs
    {
        public PipeMessageEventArgs(string commandType, IDictionary<string, object> commandParameters)
        {
            CommandType = commandType ?? string.Empty;
            CommandParameters = commandParameters ?? new Dictionary<string, object>();
        }

        public string CommandType { get; }
        public IDictionary<string, object> CommandParameters { get; }
    }

    internal sealed class PendingResponse
    {
        public PendingResponse(string commandType)
        {
            CommandType = commandType;
            WaitHandle = new AutoResetEvent(false);
        }

        public string CommandType { get; }
        public bool Accepted { get; set; }
        public string ErrorCode { get; set; }
        public string ErrorMessage { get; set; }
        public IDictionary<string, object> Payload { get; set; }
        public AutoResetEvent WaitHandle { get; }

        public string GetValue(string key)
        {
            if (Payload == null || !Payload.ContainsKey(key) || Payload[key] == null)
            {
                return string.Empty;
            }

            return Convert.ToString(Payload[key]) ?? string.Empty;
        }
    }
}
