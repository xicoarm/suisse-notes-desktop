// SysLoopback — records what a Windows computer plays, for the desktop app.
//
// Why this exists (incident 2026-08-14, meeting cmssqh4sh…; again 2026-10-03 with
// Areg's Jabra Evolve2 65): Chromium's desktopCapturer loopback always binds to the
// default MULTIMEDIA endpoint. Every conferencing app renders call audio to the
// default COMMUNICATION endpoint. When a user has a headset for calls and speakers
// for everything else — the normal setup — the browser-side capture records an idle
// endpoint: live track, no error, a whole meeting of digital silence. No web API can
// choose the endpoint, so this small native helper does what AudioTee does on macOS.
//
// Two ways to capture:
//   --process-loopback   every app EXCEPT the given process tree, on EVERY output
//                        device (Windows 10 2004+ process loopback). Microsoft: "the
//                        capture is not tied to a specific audio endpoint". The app
//                        passes its own pid, so nothing it plays itself is recorded.
//   --role / --device    one output endpoint (classic WASAPI loopback).
//
// Contract with the Electron main process (same as AudioTee, see pcm-capture.js):
//   sysloopback.exe --stdout --process-loopback --exclude-pid <pid> --sample-rate 48000
//   * raw PCM on stdout: 48 kHz, mono, signed 16-bit little endian
//   * one JSON object per line on stderr: {"message_type":"stream_start"|"error"|"info"}
//   * stops when stdin closes or a line "stop" arrives (the app can never be outlived)
//   * if process loopback cannot start (older Windows), it falls back to the default
//     communication endpoint — where meeting apps play — and says so on stderr
// Diagnostics and the local s8 harness scenario:
//   sysloopback.exe --role communications --out <file.wav> [--seconds N]
//   * writes a WAV (endpoint's native rate, mono, 16-bit) and keeps the header
//     length fields current, so an abrupt kill still leaves a playable file
//   sysloopback.exe --list        output endpoints and the three default roles
//   sysloopback.exe --sessions    apps using each output and input device right now
//                                 (one JSON line per device; the app picks the
//                                 microphone a meeting app is using from this)
//
// Built with the in-box .NET Framework compiler (csc.exe) — no SDK, no MSVC,
// no toolchain install on dev machines or CI. See scripts/build-sysloopback.js.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class SysLoopback
{
    // ---- COM plumbing -----------------------------------------------------
    // Every method is [PreserveSig]: the callers check the HRESULT themselves.
    // Without it the CLR turns a failed HRESULT into an exception and hands back
    // a meaningless 0, so AUDCLNT_E_DEVICE_INVALIDATED never reached the rebind.
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr p;
        public string AsString() { return vt == 31 ? Marshal.PtrToStringUni(p) : null; }
    }

    // IAudioClient — vtable order is load-bearing, do not reorder.
    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration,
            long hnsPeriodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint numBufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags,
            out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    // ---- process loopback (Windows 10 2004+) ------------------------------
    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath, ref Guid riid,
        IntPtr activationParams, IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult,
            [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    // ActivateAudioInterfaceAsync refuses a completion handler that is not agile.
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject { }

    private sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result = E_FAIL;
        public object Client;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                int hr;
                object client;
                int call = operation.GetActivateResult(out hr, out client);
                Result = call != 0 ? call : hr;
                Client = client;
            }
            catch (Exception ex) { Result = Marshal.GetHRForException(ex); }
            finally { Done.Set(); }
            return 0;
        }
    }

    // ---- audio sessions (which apps play where) ---------------------------
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
    }

    // IAudioSessionControl2 = IAudioSessionControl (9 methods) + 5 own ones.
    [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, IntPtr eventContext);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, IntPtr eventContext);
        [PreserveSig] int GetGroupingParam(out Guid param);
        [PreserveSig] int SetGroupingParam(ref Guid param, IntPtr eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference(bool optOut);
    }

    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormatEx
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    private const int RENDER = 0, CAPTURE = 1, ACTIVE = 1, SHARE_MODE_SHARED = 0;
    private const uint STREAMFLAGS_LOOPBACK = 0x00020000;
    private const uint STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    private const uint STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    private const uint BUFFERFLAGS_SILENT = 0x2;
    private const int E_FAIL = unchecked((int)0x80004005);
    private const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
    private const int PROCESS_LOOPBACK_UNAVAILABLE = unchecked((int)0x8889FFFF); // ours: activation impossible
    private const ushort WAVE_FORMAT_PCM = 1, WAVE_FORMAT_IEEE_FLOAT = 3, WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
    private const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
    private static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT =
        new Guid("00000003-0000-0010-8000-00aa00389b71");
    private static readonly PropertyKey PKEY_FriendlyName =
        new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

    private static volatile bool _stop;
    // --stdout: PCM owns stdout, so every event goes to stderr in AudioTee's shape.
    private static bool _pcmOnStdout;

    private static void Emit(string ev, string detail)
    {
        if (_pcmOnStdout)
        {
            string type = ev == "started" ? "stream_start" : ev == "error" ? "error" : "info";
            Console.Error.WriteLine("{\"message_type\":\"" + type + "\",\"event\":\"" + ev +
                "\",\"data\":{\"message\":" + Quote(detail) + "}}");
            Console.Error.Flush();
            return;
        }
        var line = "{\"event\":\"" + ev + "\",\"detail\":" + Quote(detail) + "}";
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }

    private static string Quote(string s)
    {
        if (s == null) return "null";
        var sb = new System.Text.StringBuilder("\"");
        foreach (var c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    private static string NameOf(IMMDevice d)
    {
        try
        {
            IPropertyStore ps;
            if (d.OpenPropertyStore(0, out ps) != 0 || ps == null) return "(unnamed)";
            PropVariant v;
            var key = PKEY_FriendlyName;
            if (ps.GetValue(ref key, out v) != 0) return "(unnamed)";
            return v.AsString() ?? "(unnamed)";
        }
        catch { return "(unnamed)"; }
    }

    private static int Main(string[] args)
    {
        // Endpoint names carry umlauts ("Kopfhörer"); the console's OEM codepage
        // would mangle them and callers match on these strings.
        try { Console.OutputEncoding = new System.Text.UTF8Encoding(false); } catch { /* redirected */ }

        string role = "communications", outPath = null, deviceId = null;
        bool list = false, sessions = false, processLoopback = false, pcmOnStdout = false, include = false;
        int seconds = 0; // 0 = run until stdin closes or "stop" (test affordance otherwise)
        int targetPid = 0, sampleRate = 48000;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--role" && i + 1 < args.Length) role = args[++i].ToLowerInvariant();
            else if (args[i] == "--out" && i + 1 < args.Length) outPath = args[++i];
            else if (args[i] == "--device" && i + 1 < args.Length) deviceId = args[++i];
            else if (args[i] == "--seconds" && i + 1 < args.Length) int.TryParse(args[++i], out seconds);
            else if (args[i] == "--exclude-pid" && i + 1 < args.Length) { int.TryParse(args[++i], out targetPid); include = false; }
            else if (args[i] == "--include-pid" && i + 1 < args.Length) { int.TryParse(args[++i], out targetPid); include = true; }
            else if (args[i] == "--sample-rate" && i + 1 < args.Length) int.TryParse(args[++i], out sampleRate);
            else if (args[i] == "--process-loopback") processLoopback = true;
            else if (args[i] == "--stdout") pcmOnStdout = true;
            else if (args[i] == "--list") list = true;
            else if (args[i] == "--sessions") sessions = true;
        }
        _pcmOnStdout = pcmOnStdout;

        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();

        if (list)
        {
            IMMDeviceCollection col;
            if (enumerator.EnumAudioEndpoints(RENDER, ACTIVE, out col) == 0 && col != null)
            {
                uint n;
                col.GetCount(out n);
                for (uint i = 0; i < n; i++)
                {
                    IMMDevice d;
                    if (col.Item(i, out d) != 0 || d == null) continue;
                    string id;
                    d.GetId(out id);
                    Emit("device", NameOf(d) + " :: " + id);
                }
            }
            for (int r = 0; r < 3; r++)
            {
                IMMDevice d;
                if (enumerator.GetDefaultAudioEndpoint(RENDER, r, out d) == 0 && d != null)
                    Emit("default", RoleName(r) + " :: " + NameOf(d));
            }
            return 0;
        }

        if (sessions)
        {
            PrintSessions(enumerator);
            return 0;
        }

        if (pcmOnStdout && sampleRate != 48000) { Emit("error", "--stdout writes 48000 Hz only"); return 2; }
        if (!pcmOnStdout && string.IsNullOrEmpty(outPath)) { Emit("error", "--out or --stdout is required"); return 2; }

        if (seconds > 0)
        {
            // Fixed-duration mode (tests/diagnostics). stdin is deliberately NOT
            // watched here: a detached process gets EOF immediately, which the
            // watcher below would correctly read as "parent died" and stop at once.
            var timer = new Thread(() => { Thread.Sleep(seconds * 1000); _stop = true; });
            timer.IsBackground = true;
            timer.Start();
        }
        else
        {
            // Production: stdin close (Electron main died) or a "stop" line ends
            // the capture cleanly, so the helper can never outlive the app.
            var reader = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                        if (line.Trim() == "stop") break;
                }
                catch { /* stdin gone */ }
                _stop = true;
            });
            reader.IsBackground = true;
            reader.Start();
        }

        try
        {
            using (PcmSink sink = pcmOnStdout ? (PcmSink)new StdoutPcmWriter() : new WavWriter(outPath))
            {
                int hr;
                if (processLoopback)
                {
                    hr = CaptureProcess(targetPid > 0 ? targetPid : System.Diagnostics.Process.GetCurrentProcess().Id,
                        include, sink);
                    if (hr == PROCESS_LOOPBACK_UNAVAILABLE && !include && !_stop)
                    {
                        // Older Windows: no process loopback. Meeting apps play on the
                        // communication endpoint, so that is the best single endpoint.
                        Emit("fallback", "process loopback unavailable — recording the default communication endpoint");
                        hr = CaptureEndpoint(enumerator, "communications", null, sink);
                    }
                }
                else
                {
                    hr = CaptureEndpoint(enumerator, role, deviceId, sink);
                }
                Emit("stopped", "frames=" + sink.FramesWritten.ToString(CultureInfo.InvariantCulture));
                return hr == 0 ? 0 : 1;
            }
        }
        catch (Exception ex) { Emit("error", ex.GetType().Name + ": " + ex.Message); return 1; }
    }

    private static string RoleName(int r)
    {
        return r == 0 ? "console" : r == 1 ? "multimedia" : "communications";
    }

    private static int RoleIndex(string role)
    {
        if (role == "console") return 0;
        if (role == "multimedia") return 1;
        return 2; // communications — where conferencing apps render
    }

    private static IMMDevice Resolve(IMMDeviceEnumerator en, string role, string deviceId)
    {
        IMMDevice d;
        if (!string.IsNullOrEmpty(deviceId) && en.GetDevice(deviceId, out d) == 0 && d != null) return d;
        if (en.GetDefaultAudioEndpoint(RENDER, RoleIndex(role), out d) == 0 && d != null) return d;
        return null;
    }

    // ---- one endpoint -------------------------------------------------------
    private static int CaptureEndpoint(IMMDeviceEnumerator en, string role, string deviceId, PcmSink sink)
    {
        // A device invalidation (headset disconnect, Bluetooth A2DP/HFP flip,
        // endpoint removed) is recoverable — re-resolve the endpoint and keep
        // going rather than losing the rest of the meeting.
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (!_stop)
        {
            var dev = Resolve(en, role, deviceId);
            if (dev == null)
            {
                Emit("error", "no render endpoint for role " + role);
                Thread.Sleep(1000);
                PadToClock(sink, clock);
                continue;
            }

            int hr = CaptureEndpointOnce(dev, sink, clock);
            if (_stop) break;
            if (hr == AUDCLNT_E_DEVICE_INVALIDATED)
            {
                Emit("rebind", "endpoint invalidated — re-resolving role " + role);
                Thread.Sleep(500);
                continue;
            }
            if (hr != 0) { Emit("error", "capture failed hr=0x" + hr.ToString("x8")); return hr; }
            break;
        }
        return 0;
    }

    private static int CaptureEndpointOnce(IMMDevice dev, PcmSink sink, System.Diagnostics.Stopwatch clock)
    {
        var iid = IID_IAudioClient;
        object clientObj;
        int hr = dev.Activate(ref iid, 1 /* CLSCTX_INPROC_SERVER */, IntPtr.Zero, out clientObj);
        if (hr != 0) return hr;
        var client = (IAudioClient)clientObj;

        IntPtr pFormat;
        hr = client.GetMixFormat(out pFormat);
        if (hr != 0) return hr;

        var wfx = (WaveFormatEx)Marshal.PtrToStructure(pFormat, typeof(WaveFormatEx));
        bool isFloat = wfx.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        if (wfx.wFormatTag == WAVE_FORMAT_EXTENSIBLE)
        {
            // WAVEFORMATEXTENSIBLE = WAVEFORMATEX(18) + Samples(2) + dwChannelMask(4),
            // so SubFormat starts at byte 24. Getting this offset wrong reads the
            // channel mask as the start of the GUID, silently mis-detects float32
            // as int32, and turns every sample into distortion.
            var sub = (Guid)Marshal.PtrToStructure(new IntPtr(pFormat.ToInt64() + 24), typeof(Guid));
            isFloat = sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
        }

        int channels = wfx.nChannels;
        int bits = wfx.wBitsPerSample;
        int rate = (int)wfx.nSamplesPerSec;
        sink.SetFormat(rate);

        // 1s shared-mode loopback buffer. Loopback cannot be event-driven, so poll.
        // 10000000 hns = 1 second. (No digit separators: the in-box .NET
        // Framework csc.exe is the legacy C# 5 compiler — see build script.)
        hr = client.Initialize(SHARE_MODE_SHARED, STREAMFLAGS_LOOPBACK, 10000000L, 0, pFormat, IntPtr.Zero);
        Marshal.FreeCoTaskMem(pFormat);
        if (hr != 0) return hr;

        Emit("started", "endpoint=" + NameOf(dev) + " rate=" + rate + " ch=" + channels +
                        " bits=" + bits + " float=" + isFloat + " tag=" + wfx.wFormatTag);
        return Pump(client, IntPtr.Zero, sink, clock, rate, channels, bits, isFloat);
    }

    // ---- every app except one process tree, on every endpoint ---------------
    private static int CaptureProcess(int pid, bool include, PcmSink sink)
    {
        // The process-loopback device has no mix format: we choose one. 48 kHz is
        // what the app wants; some builds need the engine's PCM converter and others
        // refuse the flag, so try the combinations Microsoft's sample and others use.
        var attempts = new[]
        {
            new { Tag = WAVE_FORMAT_PCM, Bits = 16, Flags = STREAMFLAGS_AUTOCONVERTPCM },
            new { Tag = WAVE_FORMAT_PCM, Bits = 16, Flags = 0u },
            new { Tag = WAVE_FORMAT_IEEE_FLOAT, Bits = 32, Flags = 0u },
        };
        const int rate = 48000, channels = 2;
        int lastHr = PROCESS_LOOPBACK_UNAVAILABLE;
        foreach (var a in attempts)
        {
            IAudioClient client;
            int hr = ActivateProcessLoopback(pid, include, out client);
            if (hr != 0)
            {
                Emit("info", "process loopback activation failed hr=0x" + hr.ToString("x8"));
                return PROCESS_LOOPBACK_UNAVAILABLE;
            }
            var wfx = new WaveFormatEx
            {
                wFormatTag = a.Tag, nChannels = channels, nSamplesPerSec = rate,
                wBitsPerSample = (ushort)a.Bits, nBlockAlign = (ushort)(channels * a.Bits / 8),
                nAvgBytesPerSec = (uint)(rate * channels * a.Bits / 8), cbSize = 0,
            };
            IntPtr pFormat = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WaveFormatEx)));
            IntPtr evt = IntPtr.Zero;
            try
            {
                Marshal.StructureToPtr(wfx, pFormat, false);
                hr = client.Initialize(SHARE_MODE_SHARED,
                    STREAMFLAGS_LOOPBACK | STREAMFLAGS_EVENTCALLBACK | a.Flags, 2000000L, 0, pFormat, IntPtr.Zero);
                if (hr != 0)
                {
                    lastHr = hr;
                    Emit("info", "process loopback format " + a.Bits + "-bit tag=" + a.Tag +
                                 " flags=0x" + a.Flags.ToString("x8") + " refused hr=0x" + hr.ToString("x8"));
                    continue;
                }
                evt = CreateEvent(IntPtr.Zero, false, false, null);
                hr = client.SetEventHandle(evt);
                if (hr != 0) return hr;
                sink.SetFormat(rate);
                Emit("started", "process-loopback " + (include ? "include" : "exclude") + "=" + pid +
                                " rate=" + rate + " ch=" + channels + " bits=" + a.Bits +
                                " float=" + (a.Tag == WAVE_FORMAT_IEEE_FLOAT) +
                                " flags=0x" + a.Flags.ToString("x8"));
                return Pump(client, evt, sink, System.Diagnostics.Stopwatch.StartNew(), rate, channels, a.Bits,
                    a.Tag == WAVE_FORMAT_IEEE_FLOAT);
            }
            finally
            {
                Marshal.FreeHGlobal(pFormat);
                if (evt != IntPtr.Zero) CloseHandle(evt);
            }
        }
        return lastHr;
    }

    private static int ActivateProcessLoopback(int pid, bool include, out IAudioClient client)
    {
        client = null;
        // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType = PROCESS_LOOPBACK (1),
        //   ProcessLoopbackParams { TargetProcessId, ProcessLoopbackMode } } — 12 bytes,
        // wrapped in a VT_BLOB PROPVARIANT (vt at 0, cbSize at 8, pBlobData at 16).
        IntPtr pParams = Marshal.AllocHGlobal(12);
        IntPtr pProp = Marshal.AllocHGlobal(24);
        try
        {
            Marshal.WriteInt32(pParams, 0, 1);
            Marshal.WriteInt32(pParams, 4, pid);
            Marshal.WriteInt32(pParams, 8, include ? 0 : 1); // INCLUDE / EXCLUDE target process tree
            for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(pProp, i, 0);
            Marshal.WriteInt16(pProp, 0, 65); // VT_BLOB
            Marshal.WriteInt32(pProp, 8, 12);
            Marshal.WriteIntPtr(pProp, 16, pParams);

            var handler = new ActivationHandler();
            var iid = IID_IAudioClient;
            IActivateAudioInterfaceAsyncOperation operation;
            int hr;
            try
            {
                hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, ref iid, pProp, handler, out operation);
            }
            catch (EntryPointNotFoundException) { return PROCESS_LOOPBACK_UNAVAILABLE; }
            catch (DllNotFoundException) { return PROCESS_LOOPBACK_UNAVAILABLE; }
            if (hr != 0) return hr;
            if (!handler.Done.WaitOne(10000)) return E_FAIL;
            GC.KeepAlive(operation);
            if (handler.Result != 0) return handler.Result;
            client = handler.Client as IAudioClient;
            return client == null ? E_FAIL : 0;
        }
        finally
        {
            Marshal.FreeHGlobal(pProp);
            Marshal.FreeHGlobal(pParams);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    // ---- the capture loop shared by both ways --------------------------------
    private static int Pump(IAudioClient client, IntPtr evt, PcmSink sink, System.Diagnostics.Stopwatch clock,
        int rate, int channels, int bits, bool isFloat)
    {
        var iidCapture = IID_IAudioCaptureClient;
        object captureObj;
        int hr = client.GetService(ref iidCapture, out captureObj);
        if (hr != 0) return hr;
        var capture = (IAudioCaptureClient)captureObj;

        hr = client.Start();
        if (hr != 0) return hr;
        try
        {
            while (!_stop)
            {
                uint packet;
                hr = capture.GetNextPacketSize(out packet);
                if (hr != 0) return hr;

                if (packet == 0)
                {
                    // Nothing queued. An endpoint with no active render stream
                    // delivers NOTHING (not even silence), so pad against the
                    // wall clock — otherwise the system track drifts shorter
                    // than the mic track and the merge desyncs.
                    PadToClock(sink, clock);
                    if (evt != IntPtr.Zero) WaitForSingleObject(evt, 10);
                    else Thread.Sleep(10);
                    continue;
                }

                while (packet != 0 && !_stop)
                {
                    IntPtr data;
                    uint frames, flags;
                    ulong devPos, qpcPos;
                    hr = capture.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
                    if (hr != 0) return hr;

                    if ((flags & BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero)
                        sink.WriteSilence((int)frames);
                    else
                        sink.WriteMixedDown(data, (int)frames, channels, bits, isFloat);

                    capture.ReleaseBuffer(frames);
                    hr = capture.GetNextPacketSize(out packet);
                    if (hr != 0) return hr;
                }
                sink.Flush();
            }
        }
        finally
        {
            try { client.Stop(); } catch { /* tearing down */ }
        }
        return 0;
    }

    private static void PadToClock(PcmSink sink, System.Diagnostics.Stopwatch clock)
    {
        long target = (long)(clock.Elapsed.TotalSeconds * sink.InputRate);
        long missing = target - sink.FramesWritten;
        if (missing > sink.InputRate / 20)
        {
            sink.WriteSilence((int)missing);
            sink.Flush();
        }
    }

    // ---- apps that use audio devices right now ---------------------------------
    private static void PrintSessions(IMMDeviceEnumerator en)
    {
        PrintSessions(en, RENDER, "output");
        PrintSessions(en, CAPTURE, "input");
        Console.Out.Flush();
    }

    private static void PrintSessions(IMMDeviceEnumerator en, int flow, string flowName)
    {
        // One JSON line per device: which apps hold a session there, whether it is
        // active, and how loud it is right now. Where does the meeting actually
        // play, and which microphone does the meeting app use — without guessing
        // from the Windows default roles.
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(flow, ACTIVE, out col) != 0 || col == null) return;
        var defaults = new Dictionary<string, List<string>>();
        for (int r = 0; r < 3; r++)
        {
            IMMDevice d;
            string id;
            if (en.GetDefaultAudioEndpoint(flow, r, out d) != 0 || d == null || d.GetId(out id) != 0) continue;
            if (!defaults.ContainsKey(id)) defaults[id] = new List<string>();
            defaults[id].Add(RoleName(r));
        }
        uint n;
        col.GetCount(out n);
        for (uint i = 0; i < n; i++)
        {
            IMMDevice dev;
            if (col.Item(i, out dev) != 0 || dev == null) continue;
            string devId;
            dev.GetId(out devId);
            var roles = defaults.ContainsKey(devId ?? "") ? defaults[devId] : new List<string>();
            var apps = new List<string>();
            var iidMgr = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            object mgrObj;
            if (dev.Activate(ref iidMgr, 1, IntPtr.Zero, out mgrObj) == 0 && mgrObj != null)
            {
                var mgr = (IAudioSessionManager2)mgrObj;
                IAudioSessionEnumerator list;
                int count;
                if (mgr.GetSessionEnumerator(out list) == 0 && list != null && list.GetCount(out count) == 0)
                {
                    for (int s = 0; s < count; s++)
                    {
                        IAudioSessionControl2 session;
                        if (list.GetSession(s, out session) != 0 || session == null) continue;
                        int state;
                        uint pid;
                        session.GetState(out state);
                        session.GetProcessId(out pid);
                        float peak = 0;
                        var meter = session as IAudioMeterInformation;
                        if (meter != null) meter.GetPeakValue(out peak);
                        apps.Add("{\"pid\":" + pid + ",\"app\":" + Quote(ProcessName(pid)) +
                                 ",\"active\":" + (state == 1 ? "true" : "false") +
                                 ",\"peak\":" + peak.ToString("0.0000", CultureInfo.InvariantCulture) + "}");
                    }
                }
            }
            var quotedRoles = new List<string>();
            foreach (var r in roles) quotedRoles.Add(Quote(r));
            Console.Out.WriteLine("{\"flow\":\"" + flowName + "\",\"device\":" + Quote(NameOf(dev)) + ",\"defaultFor\":[" +
                string.Join(",", quotedRoles.ToArray()) + "],\"sessions\":[" + string.Join(",", apps.ToArray()) + "]}");
        }
    }

    private static string ProcessName(uint pid)
    {
        if (pid == 0) return "system";
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
        catch { return ""; }
    }

    // ---- writers --------------------------------------------------------------
    /// Where captured audio goes: mono 16-bit, written as it arrives. FramesWritten
    /// counts frames at the INPUT rate, which is what the wall-clock padding uses.
    private abstract class PcmSink : IDisposable
    {
        public abstract long FramesWritten { get; }
        public abstract int InputRate { get; }
        public abstract void SetFormat(int rate);
        public abstract void WriteSilence(int frames);
        public abstract void WriteMono(double[] samples, int count);
        public virtual void Flush() { }
        public abstract void Dispose();

        public unsafe void WriteMixedDown(IntPtr data, int frames, int channels, int bits, bool isFloat)
        {
            if (frames <= 0 || channels <= 0) return;
            var mono = new double[frames];
            var src = (byte*)data.ToPointer();
            for (int f = 0; f < frames; f++)
            {
                double sum = 0;
                for (int c = 0; c < channels; c++)
                {
                    if (isFloat && bits == 32)
                        sum += *(float*)(src + ((f * channels + c) * 4));
                    else if (bits == 16)
                        sum += *(short*)(src + ((f * channels + c) * 2)) / 32768.0;
                    else if (bits == 32)
                        sum += *(int*)(src + ((f * channels + c) * 4)) / 2147483648.0;
                }
                mono[f] = sum / channels;
            }
            WriteMono(mono, frames);
        }

        protected static short ToPcm16(double v)
        {
            if (v > 1.0) v = 1.0; else if (v < -1.0) v = -1.0;
            return (short)(v * 32767.0);
        }
    }

    /// Raw 48 kHz mono s16le on stdout — AudioTee's contract. A device running at
    /// another rate (44.1 kHz) is resampled linearly; speech needs nothing finer.
    private sealed class StdoutPcmWriter : PcmSink
    {
        private const int OutRate = 48000;
        private readonly Stream _out = Console.OpenStandardOutput();
        private int _inRate = OutRate;
        private long _inFrames;
        private double _phase = 1.0; // position between _prev and the next input sample
        private double _prev;
        private byte[] _buf = new byte[0];

        public override long FramesWritten { get { return _inFrames; } }
        public override int InputRate { get { return _inRate; } }

        public override void SetFormat(int rate)
        {
            if (rate > 0) _inRate = rate; // a rebind may change the endpoint's rate
        }

        public override void WriteSilence(int frames)
        {
            if (frames <= 0) return;
            var zeros = new double[Math.Min(frames, 48000)];
            int left = frames;
            while (left > 0)
            {
                int n = Math.Min(left, zeros.Length);
                WriteMono(zeros, n);
                left -= n;
            }
        }

        public override void WriteMono(double[] samples, int count)
        {
            if (count <= 0) return;
            _inFrames += count;
            int max = _inRate == OutRate ? count : (int)((long)count * OutRate / _inRate) + 2;
            if (_buf.Length < max * 2) _buf = new byte[max * 2];
            int o = 0;
            if (_inRate == OutRate)
            {
                for (int i = 0; i < count; i++) PutSample(ref o, samples[i]);
            }
            else
            {
                double step = (double)_inRate / OutRate;
                for (int i = 0; i < count; i++)
                {
                    double s = samples[i];
                    while (_phase <= 1.0 && o + 2 <= _buf.Length)
                    {
                        PutSample(ref o, _prev + (s - _prev) * _phase);
                        _phase += step;
                    }
                    _phase -= 1.0;
                    _prev = s;
                }
            }
            _out.Write(_buf, 0, o);
        }

        private void PutSample(ref int o, double v)
        {
            short s = ToPcm16(v);
            _buf[o++] = (byte)(s & 0xFF);
            _buf[o++] = (byte)((s >> 8) & 0xFF);
        }

        public override void Flush()
        {
            try { _out.Flush(); } catch { /* the app closed the pipe */ }
        }

        public override void Dispose()
        {
            Flush();
        }
    }

    /// Streaming WAV writer: mono 16-bit at the endpoint's native rate. Header
    /// sizes are rewritten as data grows, so killing the process still leaves a
    /// file ffmpeg can read (the recording must survive a crash).
    private sealed class WavWriter : PcmSink
    {
        private readonly FileStream _fs;
        private readonly BinaryWriter _bw;
        private int _rate;
        private long _dataBytes;
        private long _lastHeaderUpdate;
        public override long FramesWritten { get { return _dataBytes / 2; } }
        public override int InputRate { get { return _rate; } }

        public WavWriter(string path)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            _fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
            _bw = new BinaryWriter(_fs);
            _rate = 48000;
            WriteHeader();
        }

        public override void SetFormat(int rate)
        {
            if (_dataBytes != 0 || rate <= 0) return; // format is fixed once audio flows
            _rate = rate;
            _fs.Seek(0, SeekOrigin.Begin);
            WriteHeader();
        }

        private void WriteHeader()
        {
            _bw.Write(new[] { 'R', 'I', 'F', 'F' });
            _bw.Write((uint)(36 + _dataBytes));
            _bw.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
            _bw.Write(16u);
            _bw.Write((ushort)1);              // PCM
            _bw.Write((ushort)1);              // mono
            _bw.Write((uint)_rate);
            _bw.Write((uint)(_rate * 2));      // byte rate
            _bw.Write((ushort)2);              // block align
            _bw.Write((ushort)16);             // bits
            _bw.Write(new[] { 'd', 'a', 't', 'a' });
            _bw.Write((uint)_dataBytes);
            _bw.Flush();
        }

        private void RefreshHeaderPeriodically()
        {
            if (_dataBytes - _lastHeaderUpdate < _rate * 2 * 5) return; // ~every 5s
            _lastHeaderUpdate = _dataBytes;
            long pos = _fs.Position;
            _fs.Seek(4, SeekOrigin.Begin);
            _bw.Write((uint)(36 + _dataBytes));
            _fs.Seek(40, SeekOrigin.Begin);
            _bw.Write((uint)_dataBytes);
            _bw.Flush();
            _fs.Seek(pos, SeekOrigin.Begin);
        }

        public override void WriteSilence(int frames)
        {
            if (frames <= 0) return;
            var buf = new byte[Math.Min(frames, 48000) * 2];
            int left = frames;
            while (left > 0)
            {
                int n = Math.Min(left, buf.Length / 2);
                _fs.Write(buf, 0, n * 2);
                _dataBytes += n * 2;
                left -= n;
            }
            RefreshHeaderPeriodically();
        }

        public override void WriteMono(double[] samples, int count)
        {
            if (count <= 0) return;
            var outBuf = new byte[count * 2];
            for (int f = 0; f < count; f++)
            {
                short s = ToPcm16(samples[f]);
                outBuf[f * 2] = (byte)(s & 0xFF);
                outBuf[f * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }
            _fs.Write(outBuf, 0, outBuf.Length);
            _dataBytes += outBuf.Length;
            RefreshHeaderPeriodically();
        }

        public override void Dispose()
        {
            try
            {
                _fs.Seek(4, SeekOrigin.Begin);
                _bw.Write((uint)(36 + _dataBytes));
                _fs.Seek(40, SeekOrigin.Begin);
                _bw.Write((uint)_dataBytes);
                _bw.Flush();
            }
            catch { /* best effort */ }
            _bw.Close();
            _fs.Dispose();
        }
    }
}
