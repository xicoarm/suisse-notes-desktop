// SysLoopback — WASAPI loopback capture of a CHOSEN Windows output endpoint.
//
// Why this exists (incident 2026-08-14, meeting cmssqh4sh…): Chromium's
// desktopCapturer loopback always binds to the default MULTIMEDIA endpoint.
// Every conferencing app renders call audio to the default COMMUNICATION
// endpoint. When a user has a headset for calls and speakers for everything
// else — the normal setup — the browser-side capture records an idle endpoint:
// live track, no error, 68 minutes of digital silence. No web API can choose
// the endpoint, so this small native helper does what AudioTee does on macOS.
//
// Contract with the Electron main process:
//   sysloopback.exe --role communications --out <file.wav> [--list]
//   * writes a WAV (endpoint's native rate, mono, 16-bit) and keeps the header
//     length fields current, so an abrupt kill still leaves a playable file
//   * stops cleanly when stdin closes or a line "stop" arrives
//   * one line of JSON per event on stdout, so main.log gets real diagnostics
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
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        int GetCount(out uint count);
        int Item(uint index, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        int GetCount(out int count);
        int GetAt(int index, out PropertyKey key);
        int GetValue(ref PropertyKey key, out PropVariant value);
        int SetValue(ref PropertyKey key, ref PropVariant value);
        int Commit();
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
        int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration,
            long hnsPeriodicity, IntPtr format, IntPtr audioSessionGuid);
        int GetBufferSize(out uint numBufferFrames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint numPaddingFrames);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr deviceFormat);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags,
            out ulong devicePosition, out ulong qpcPosition);
        int ReleaseBuffer(uint numFramesRead);
        int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormatEx
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    private const int RENDER = 0, ACTIVE = 1, SHARE_MODE_SHARED = 0;
    private const uint STREAMFLAGS_LOOPBACK = 0x00020000;
    private const uint BUFFERFLAGS_SILENT = 0x2;
    private const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
    private const ushort WAVE_FORMAT_IEEE_FLOAT = 3, WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
    private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT =
        new Guid("00000003-0000-0010-8000-00aa00389b71");
    private static readonly PropertyKey PKEY_FriendlyName =
        new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

    private static volatile bool _stop;

    private static void Emit(string ev, string detail)
    {
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
            d.OpenPropertyStore(0, out ps);
            PropVariant v;
            var key = PKEY_FriendlyName;
            ps.GetValue(ref key, out v);
            return v.AsString() ?? "(unnamed)";
        }
        catch { return "(unnamed)"; }
    }

    private static int Main(string[] args)
    {
        string role = "communications", outPath = null, deviceId = null;
        bool list = false;
        int seconds = 0; // 0 = run until stdin closes or "stop" (test affordance otherwise)
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--role" && i + 1 < args.Length) role = args[++i].ToLowerInvariant();
            else if (args[i] == "--out" && i + 1 < args.Length) outPath = args[++i];
            else if (args[i] == "--device" && i + 1 < args.Length) deviceId = args[++i];
            else if (args[i] == "--seconds" && i + 1 < args.Length) int.TryParse(args[++i], out seconds);
            else if (args[i] == "--list") list = true;
        }

        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();

        if (list)
        {
            IMMDeviceCollection col;
            enumerator.EnumAudioEndpoints(RENDER, ACTIVE, out col);
            uint n;
            col.GetCount(out n);
            for (uint i = 0; i < n; i++)
            {
                IMMDevice d;
                col.Item(i, out d);
                string id;
                d.GetId(out id);
                Emit("device", NameOf(d) + " :: " + id);
            }
            for (int r = 0; r < 3; r++)
            {
                IMMDevice d;
                if (enumerator.GetDefaultAudioEndpoint(RENDER, r, out d) == 0)
                    Emit("default", RoleName(r) + " :: " + NameOf(d));
            }
            return 0;
        }

        if (string.IsNullOrEmpty(outPath)) { Emit("error", "--out is required"); return 2; }

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

        try { return Capture(enumerator, role, deviceId, outPath); }
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
        if (!string.IsNullOrEmpty(deviceId) && en.GetDevice(deviceId, out d) == 0) return d;
        if (en.GetDefaultAudioEndpoint(RENDER, RoleIndex(role), out d) == 0) return d;
        return null;
    }

    private static int Capture(IMMDeviceEnumerator en, string role, string deviceId, string outPath)
    {
        using (var wav = new WavWriter(outPath))
        {
            // Outer loop: a device invalidation (headset disconnect, Bluetooth
            // A2DP/HFP flip, endpoint removed) is recoverable — re-resolve the
            // endpoint and keep going rather than losing the rest of the meeting.
            while (!_stop)
            {
                var dev = Resolve(en, role, deviceId);
                if (dev == null) { Emit("error", "no render endpoint for role " + role); Thread.Sleep(1000); continue; }

                int hr = CaptureOnce(dev, wav);
                if (_stop) break;
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED)
                {
                    Emit("rebind", "endpoint invalidated — re-resolving role " + role);
                    Thread.Sleep(500);
                    continue;
                }
                if (hr != 0) { Emit("error", "capture failed hr=0x" + hr.ToString("x8")); return 1; }
                break;
            }
            Emit("stopped", "frames=" + wav.FramesWritten.ToString(CultureInfo.InvariantCulture));
        }
        return 0;
    }

    private static int CaptureOnce(IMMDevice dev, WavWriter wav)
    {
        var iidAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        object clientObj;
        int hr = dev.Activate(ref iidAudioClient, 1 /* CLSCTX_INPROC_SERVER */, IntPtr.Zero, out clientObj);
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
        wav.SetFormat(rate);

        // 1s shared-mode loopback buffer. Loopback cannot be event-driven, so poll.
        // 10000000 hns = 1 second. (No digit separators: the in-box .NET
        // Framework csc.exe is the legacy C# 5 compiler — see build script.)
        hr = client.Initialize(SHARE_MODE_SHARED, STREAMFLAGS_LOOPBACK, 10000000L, 0, pFormat, IntPtr.Zero);
        Marshal.FreeCoTaskMem(pFormat);
        if (hr != 0) return hr;

        var iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object captureObj;
        hr = client.GetService(ref iidCapture, out captureObj);
        if (hr != 0) return hr;
        var capture = (IAudioCaptureClient)captureObj;

        hr = client.Start();
        if (hr != 0) return hr;
        Emit("started", "endpoint=" + NameOf(dev) + " rate=" + rate + " ch=" + channels +
                        " bits=" + bits + " float=" + isFloat + " tag=" + wfx.wFormatTag);

        long framesTarget = 0;
        var sw = System.Diagnostics.Stopwatch.StartNew();
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
                    framesTarget = (long)(sw.Elapsed.TotalSeconds * rate);
                    long missing = framesTarget - wav.FramesWritten;
                    if (missing > rate / 20) wav.WriteSilence((int)missing);
                    Thread.Sleep(10);
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
                        wav.WriteSilence((int)frames);
                    else
                        wav.WriteMixedDown(data, (int)frames, channels, bits, isFloat);

                    capture.ReleaseBuffer(frames);
                    hr = capture.GetNextPacketSize(out packet);
                    if (hr != 0) return hr;
                }
            }
        }
        finally
        {
            try { client.Stop(); } catch { /* tearing down */ }
        }
        return 0;
    }

    /// Streaming WAV writer: mono 16-bit at the endpoint's native rate. Header
    /// sizes are rewritten as data grows, so killing the process still leaves a
    /// file ffmpeg can read (the recording must survive a crash).
    private sealed class WavWriter : IDisposable
    {
        private readonly FileStream _fs;
        private readonly BinaryWriter _bw;
        private int _rate;
        private long _dataBytes;
        private long _lastHeaderUpdate;
        public long FramesWritten { get { return _dataBytes / 2; } }

        public WavWriter(string path)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            _fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
            _bw = new BinaryWriter(_fs);
            _rate = 48000;
            WriteHeader();
        }

        public void SetFormat(int rate)
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

        public void WriteSilence(int frames)
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

        public unsafe void WriteMixedDown(IntPtr data, int frames, int channels, int bits, bool isFloat)
        {
            if (frames <= 0 || channels <= 0) return;
            var outBuf = new byte[frames * 2];
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
                double v = sum / channels;
                if (v > 1.0) v = 1.0; else if (v < -1.0) v = -1.0;
                short s = (short)(v * 32767.0);
                outBuf[f * 2] = (byte)(s & 0xFF);
                outBuf[f * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }

            _fs.Write(outBuf, 0, outBuf.Length);
            _dataBytes += outBuf.Length;
            RefreshHeaderPeriodically();
        }

        public void Dispose()
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
