using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace LangLinkMemoQBridgeHelper
{
    // The memoQ grid can expose placeholder dots through UIA. Its native Quick Find
    // field contains the selected application text, including U+FFFC inline objects.
    internal static class DesktopEditor
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct ThreadInfo
        {
            public int Size, Flags;
            public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
            public int Left, Top, Right, Bottom;
        }
        [StructLayout(LayoutKind.Sequential)] private struct Rect { public int L, T, R, B; }
        [DllImport("user32")] private static extern bool SetProcessDPIAware();
        [DllImport("user32")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        private delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
        [DllImport("user32")] private static extern bool EnumChildWindows(IntPtr w, EnumProc proc, IntPtr arg);
        [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr w);
        [DllImport("user32")] private static extern bool GetWindowRect(IntPtr w, out Rect r);
        [DllImport("user32")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
        [DllImport("user32")] private static extern bool GetGUIThreadInfo(uint thread, ref ThreadInfo info);
        [DllImport("user32", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr w, StringBuilder b, int size);
        [DllImport("user32")] private static extern bool IsWindowEnabled(IntPtr w);
        [DllImport("user32")] private static extern bool IsWindowUnicode(IntPtr w);
        [DllImport("user32", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr w, int index);
        [DllImport("imm32")] private static extern IntPtr ImmGetContext(IntPtr w);
        [DllImport("imm32")] private static extern bool ImmReleaseContext(IntPtr w, IntPtr context);
        [DllImport("imm32", CharSet = CharSet.Unicode)] private static extern int ImmGetCompositionStringW(IntPtr ctx, uint index, IntPtr buffer, int size);
        [DllImport("user32")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr w, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);

        private static void Require(bool ok, string reason)
        {
            if (!ok) throw new InvalidOperationException(reason);
        }
        private static uint Pid(IntPtr w) { GetWindowThreadProcessId(w, out var pid); return pid; }
        internal static string WithEditor(uint serverPid, Func<string> action)
        {
            Require(serverPid != 0 && Pid(GetForegroundWindow()) == serverPid,
                "blocked: focus the memoQ window connected to this Preview pipe");
            using (var gate = new Mutex(false, @"Local\LangLink.MemoQ.Edit." + serverPid))
            {
                bool owns;
                try { owns = gate.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
                Require(owns, "blocked: another helper is using this editor");
                try { return action(); } finally { gate.ReleaseMutex(); }
            }
        }
        private static IntPtr MainWindow()
        {
            var w = GetForegroundWindow();
            Require(w != IntPtr.Zero, "Unlock Windows and focus the memoQ editor.");
            using (var p = Process.GetProcessById((int)Pid(w)))
            {
                Require(string.Equals(p.ProcessName, "memoQ", StringComparison.OrdinalIgnoreCase) && p.MainWindowHandle == w,
                    "Bring the memoQ translation grid to the foreground and close open dialogs.");
            }
            return w;
        }
        private static IntPtr Focus(IntPtr w)
        {
            var info = new ThreadInfo { Size = Marshal.SizeOf(typeof(ThreadInfo)) };
            return GetGUIThreadInfo(GetWindowThreadProcessId(w, out _), ref info) ? info.Focus : IntPtr.Zero;
        }
        private static bool IsRich(IntPtr w)
        {
            var b = new StringBuilder(200);
            return GetClassName(w, b, b.Capacity) > 0 && b.ToString().IndexOf("RichEdit", StringComparison.OrdinalIgnoreCase) >= 0;
        }
        private static void CheckIme(IntPtr w)
        {
            var ctx = ImmGetContext(w);
            if (ctx == IntPtr.Zero) return;
            try { Require(ImmGetCompositionStringW(ctx, 8, IntPtr.Zero, 0) <= 0, "Finish the current IME composition."); }
            finally { ImmReleaseContext(w, ctx); }
        }
        private static void Message(IntPtr w, uint msg, int value, int arg)
        {
            Require(SendMessageTimeout(w, msg, new IntPtr(value), new IntPtr(arg), 2, 500, out _) != IntPtr.Zero,
                "memoQ did not acknowledge an editor message.");
        }
        [DllImport("user32")] private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
        [DllImport("user32")] private static extern uint MapVirtualKey(uint code, uint mapping);
        private static void Scan(byte key, bool release)
        {
            byte vk = key == 16 ? (byte)0xA0 : key == 17 ? (byte)0xA2 : key;
            uint extended = key == 35 || key == 37 || key == 39 || key == 46 ? 1u : 0u;
            keybd_event(0, (byte)MapVirtualKey(vk, 0), 8u | extended | (release ? 2u : 0u), UIntPtr.Zero);
        }
        private static void Key(IntPtr window, byte key, byte modifier = 0)
        {
            Require(GetForegroundWindow() == window, "Foreground window changed.");
            if (modifier != 0) Scan(modifier, false);
            try { Scan(key, false); Scan(key, true); }
            finally { if (modifier != 0) Scan(modifier, true); }
            Thread.Sleep(24);
        }
        private sealed class Cell
        {
            internal IntPtr Handle;
            internal Rect Bounds;
            internal string Name;
        }
        private static List<Cell> Cells(IntPtr w)
        {
            try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
            var cells = new List<Cell>();
            EnumChildWindows(w, (child, unused) =>
            {
                if (IsWindowVisible(child) && IsRich(child) && GetWindowRect(child, out var r) && r.R > r.L && r.B > r.T)
                {
                    cells.Add(new Cell { Handle = child, Bounds = r, Name = AutomationElement.FromHandle(child).Current.Name });
                }
                return true;
            }, IntPtr.Zero);
            return cells;
        }
        private static Cell Target(List<Cell> cells, int number)
        {
            var label = number.ToString(CultureInfo.InvariantCulture) + ".";
            var marked = cells.Where(c => c.Name == label).ToArray();
            Require(marked.Length == 1, "Requested row is not uniquely visible. Re-read or focus the segment.");
            var m = marked[0];
            int mid = (m.Bounds.T + m.Bounds.B) / 2;
            var neighbors = cells.Where(c => c != m && c.Bounds.T <= mid && mid < c.Bounds.B).ToArray();
            var pair = neighbors.Where(c => Math.Min(Math.Abs(m.Bounds.R - c.Bounds.L), Math.Abs(c.Bounds.R - m.Bounds.L)) <= 12).ToArray();
            Require(pair.Length == 1, "Cannot identify the adjacent source and target cells (" + m.Bounds.L + ".." + m.Bounds.R +
                "; neighbors " + string.Join(",", neighbors.Select(c => c.Bounds.L + ".." + c.Bounds.R)) + ").");
            return pair[0].Bounds.L > m.Bounds.L ? pair[0] : m;
        }
        private static void Click(IntPtr w, Cell cell)
        {
            Require(GetForegroundWindow() == w && IsWindowVisible(cell.Handle), "Editor layout or foreground changed.");
            // Coordinates are local to the cell just identified, never a desktop row offset.
            Require(PostMessage(cell.Handle, 0x0201, new IntPtr(1), new IntPtr(0x00060006)) &&
                PostMessage(cell.Handle, 0x0202, IntPtr.Zero, new IntPtr(0x00060006)), "Cannot focus the target cell.");
            Thread.Sleep(200);
        }
        internal static string Activate(int row, bool forceTransition)
        {
            try
            {
                var w = MainWindow();
                CheckIme(Focus(w));
                var cells = Cells(w);
                Target(cells, row);
                if (forceTransition)
                {
                    var another = cells.Select(c => c.Name).Where(n => n != null && n.EndsWith("."))
                        .Select(n => int.TryParse(n.TrimEnd('.'), out var i) ? i : 0).FirstOrDefault(i => i > 0 && i != row);
                    if (another != 0) Click(w, Target(cells, another));
                }
                Click(w, Target(Cells(w), row));
                return null;
            }
            catch (Exception e) { return "blocked: " + e.Message; }
        }
        private static void VerifyFocus(IntPtr w, IntPtr hwnd, Func<bool> active)
        {
            Require(active() && GetForegroundWindow() == w && Focus(w) == hwnd && IsWindowEnabled(hwnd),
                "Target editor or active Preview segment changed (active=" + active() + ", foreground=" +
                (GetForegroundWindow() == w) + ", targetFocus=" + (Focus(w) == hwnd) + ").");
            CheckIme(hwnd);
        }
        private static string SelectedText(IntPtr w, IntPtr hwnd, Func<bool> active)
        {
            VerifyFocus(w, hwnd, active);
            Key(w, 0x46, 17); // memoQ Quick Find, populated from the selection
            var timer = Stopwatch.StartNew();
            IntPtr dlg;
            do { Thread.Sleep(25); dlg = GetForegroundWindow(); } while (dlg == w && timer.ElapsedMilliseconds < 1100);
            Require(dlg != w && Pid(dlg) == Pid(w), "Quick Find is unavailable or was interrupted.");
            var root = AutomationElement.FromHandle(dlg);
            var combo = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "FindWhatComboBox"));
            Require(combo != null, "Unrecognized memoQ Find window. Inspect the active dialog.");
            try
            {
                var field = combo.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                Require(field != null && field.TryGetCurrentPattern(ValuePattern.Pattern, out _), "Find text is unavailable.");
                Thread.Sleep(120);
                return ((ValuePattern)field.GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
            }
            finally
            {
                if (GetForegroundWindow() == dlg) Key(dlg, 27);
                for (int i = 0; i < 24 && GetForegroundWindow() != w; i++) Thread.Sleep(25);
            }
        }
        // Quick Find can reuse the prior search when the cell is empty. memoQ also exposes
        // the current source/target lengths in its status strip, including inline-object counts.
        private static string FullText(IntPtr window, IntPtr hwnd, Func<bool> active, bool mayBeEmpty)
        {
            VerifyFocus(window, hwnd, active);
            if (mayBeEmpty)
            {
                var root = AutomationElement.FromHandle(window);
                var bar = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.NameProperty, "statusStrip"));
                if (bar != null)
                {
                    var items = bar.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                    foreach (AutomationElement item in items)
                    {
                        if (Regex.IsMatch(item.Current.Name ?? "", @"^.*:\s*\d+\s*\+\s*\d+\s*/\s*0\s*\+\s*0\s*$"))
                            return "";
                    }
                }
            }
            Key(window, 65, 17);
            return SelectedText(window, hwnd, active);
        }
        internal static string Inspect(int row, bool mayBeEmpty, Func<bool> active)
        {
            var w = MainWindow();
            var hwnd = Target(Cells(w), row).Handle;
            return FullText(w, hwnd, active, mayBeEmpty).Replace("\uFFFC", "");
        }
        private static int NativeStart(string raw, string expected, string oldText, int start)
        {
            Require(raw.Replace("\uFFFC", "") == expected, "Current target differs from reviewed Preview text.");
            int offset = 0;
            for (int i = 0; i < raw.Length; i++)
            {
                if (raw[i] == '\uFFFC') continue;
                if (offset++ != start) continue;
                Require(i + oldText.Length <= raw.Length && string.CompareOrdinal(raw, i, oldText, 0, oldText.Length) == 0,
                    "Requested text crosses an inline tag.");
                return i;
            }
            Require(start == 0 && raw.Length == 0 && oldText.Length == 0, "Cannot map the native range.");
            return 0;
        }
        private static void SelectRange(IntPtr w, string raw, int start, int length, Func<bool> active)
        {
            // Collapse a full cell selection to the end, including wrapped lines.
            Key(w, 65, 17); Key(w, 39);
            int suffix = StringInfo.ParseCombiningCharacters(raw.Substring(start + length)).Length;
            int units = StringInfo.ParseCombiningCharacters(raw.Substring(start, length)).Length;
            Require(suffix + units <= 2048, "Native keyboard range is too long for bounded selection.");
            for (int i = 0; i < suffix; i++)
            {
                Require(active(), "Request cancelled or active segment changed during navigation.");
                Key(w, 37);
            }
            if (units > 0)
            {
                Scan(16, false);
                try
                {
                    for (int i = 0; i < units; i++)
                    {
                        Require(active(), "Request cancelled or active segment changed during selection.");
                        Key(w, 37);
                    }
                }
                finally { Scan(16, true); }
            }
        }
        internal static string Replace(int row, string expected, string oldText, string newText, int start, Func<bool> active)
        {
            bool writing = false;
            string stage = "resolve target";
            try
            {
                var w = MainWindow();
                var hwnd = Target(Cells(w), row).Handle;
                VerifyFocus(w, hwnd, active);
                Require(IsWindowUnicode(hwnd) && (GetWindowLong(hwnd, -16) & 0x800) == 0, "Read-only target editor.");
                Require(!newText.Any(char.IsControl), "Control characters require a different editor operation.");
                stage = "read full target";
                var raw = FullText(w, hwnd, active, expected.Length == 0);
                var cell = Target(Cells(w), row); Click(w, cell); hwnd = cell.Handle;
                VerifyFocus(w, hwnd, active);
                var pos = NativeStart(raw, expected, oldText, start);
                if (oldText.Length > 0)
                {
                    stage = "verify old text";
                    SelectRange(w, raw, pos, oldText.Length, active);
                    var selected = SelectedText(w, hwnd, active);
                    Require(selected == oldText, "Selected text differs from the requested range. Inspect the active cell before retrying.");
                    cell = Target(Cells(w), row); Click(w, cell); hwnd = cell.Handle;
                }
                VerifyFocus(w, hwnd, active);
                // memoQ can collapse a selection on modifier release. Place the caret at
                // its verified start and delete the old text one text element at a time.
                SelectRange(w, raw, pos, 0, active);
                VerifyFocus(w, hwnd, active);
                stage = "replace";
                writing = true;
                var deleteCount = StringInfo.ParseCombiningCharacters(oldText).Length;
                for (int i = 0; i < deleteCount; i++)
                {
                    VerifyFocus(w, hwnd, active);
                    Key(w, 46);
                }
                foreach (char ch in newText)
                {
                    VerifyFocus(w, hwnd, active);
                    Message(hwnd, 0x0102, ch, 1); // UTF-16 code units, including surrogate pairs
                }
                VerifyFocus(w, hwnd, active);
                stage = "verify native target";
                var after = FullText(w, hwnd, active, raw.Length == oldText.Length && newText.Length == 0);
                Require(after == raw.Remove(pos, oldText.Length).Insert(pos, newText),
                    "Native target text or inline-object positions changed unexpectedly.");
                // Leaving a row commits the pending edit without confirming it in the TM.
                var cells = Cells(w);
                var other = cells.Select(c => c.Name).Where(n => n != null && n.EndsWith("."))
                    .Select(n => int.TryParse(n.TrimEnd('.'), out var i) ? i : 0).FirstOrDefault(i => i > 0 && i != row);
                if (other != 0 && active() && GetForegroundWindow() == w) Click(w, Target(cells, other));
                return null;
            }
            catch (Exception e) { return (writing ? "unverified: " : "blocked: ") + stage + ": " + e.Message; }
        }
    }
}
