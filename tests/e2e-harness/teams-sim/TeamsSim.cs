// TeamsSim — a stand-in for Microsoft Teams in the desktop app's E2E harness.
//
// Why this exists (Areg, 04.10.2026: "can we simulate the Teams conversations, so
// nobody has to test by hand before a release?"): the 03.10.2026 failure was not in
// our code paths that tests already covered, it was the Windows device topology of a
// real call — Teams plays the far end on the COMMUNICATION output (a Jabra headset)
// while the default output is the laptop speakers, and Teams holds its own
// microphone open. This tool behaves like Teams does on that level, so the real
// desktop app can be tested against it without a person, a headset or a call:
//
//   * its process name starts with "ms-teams", which is how the app recognises
//     Teams (src/services/microphoneChoice.js MEETING_APPS);
//   * it plays the far end (a WAV of synthetic voices) through WASAPI on the
//     communication output, like Teams, or on any named output device;
//   * it holds a microphone open like Teams, so "Automatisch" can see which
//     microphone the meeting uses (sysloopback.exe --sessions);
//   * it reports, as JSON lines on stdout, which devices it used and when the
//     first sample went out, so the verifier can line the recording up.
//
// Usage:
//   ms-teams-sim.exe --list
//       every active output and input device with its default roles
//   ms-teams-sim.exe --play <file.wav> [--role communications|console|multimedia]
//                    [--device <name part or id>] [--gain-db N] [--session-volume 0..1]
//                    [--hold-mic [--mic-role communications] [--mic-device <name part>]]
//                    [--wait-go] [--linger <seconds>]
//       --wait-go: open everything, print "ready", start on the stdin line "go"
//       stops when the file ends (+ linger), on the stdin line "stop", or on stdin EOF
//   ms-teams-sim.exe --hold-mic [--mic-device <name part>] (no --play): mic only, until "stop"
//   ms-teams-sim.exe --set-default <name part> --flow render|capture [--roles all|console|multimedia|communications]
//       CI only: build a call topology (e.g. communications != default output)
//   ms-teams-sim.exe --rename <name part> --flow render|capture --to <description>
//       CI only, needs admin: give a virtual device a headset-like name
//
// Built with the in-box .NET Framework compiler like resources/sysloopback (C# 5:
// no string interpolation, no ?. operator). See build.js next to this file.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class TeamsSim
{
    // ---- COM plumbing (same contracts as resources/sysloopback) ----------------
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

    // Full x64 PROPVARIANT size (24 bytes): GetValue copies the whole struct.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
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

    [Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioRenderClient
    {
        [PreserveSig] int GetBuffer(uint numFramesRequested, out IntPtr data);
        [PreserveSig] int ReleaseBuffer(uint numFramesWritten, uint flags);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags,
            out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute(bool mute, ref Guid eventContext);
        [PreserveSig] int GetMute(out bool mute);
    }

    // Undocumented but stable since Windows 7: what the Sound control panel uses to
    // change the default devices. Only SetDefaultEndpoint is called; the slots before
    // it only have to exist so the vtable offset is right.
    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    private class PolicyConfigClient { }

    [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat(IntPtr id, IntPtr format);
        [PreserveSig] int GetDeviceFormat(IntPtr id, int useDefault, IntPtr format);
        [PreserveSig] int ResetDeviceFormat(IntPtr id);
        [PreserveSig] int SetDeviceFormat(IntPtr id, IntPtr endpointFormat, IntPtr mixFormat);
        [PreserveSig] int GetProcessingPeriod(IntPtr id, int useDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
        [PreserveSig] int SetProcessingPeriod(IntPtr id, IntPtr period);
        [PreserveSig] int GetShareMode(IntPtr id, IntPtr mode);
        [PreserveSig] int SetShareMode(IntPtr id, IntPtr mode);
        [PreserveSig] int GetPropertyValue(IntPtr id, int fxStore, IntPtr key, IntPtr value);
        [PreserveSig] int SetPropertyValue(IntPtr id, int fxStore, IntPtr key, IntPtr value);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
        [PreserveSig] int SetEndpointVisibility(IntPtr id, int visible);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormatEx
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    private const int RENDER = 0, CAPTURE = 1, ACTIVE = 1, SHARE_MODE_SHARED = 0;
    private const uint STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    private const uint STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    private const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
    private const ushort WAVE_FORMAT_PCM = 1, WAVE_FORMAT_IEEE_FLOAT = 3, WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
    private static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioRenderClient = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");
    private static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    private static readonly Guid IID_ISimpleAudioVolume = new Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8");
    private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");
    private static readonly PropertyKey PKEY_FriendlyName =
        new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    private static readonly PropertyKey PKEY_DeviceDesc =
        new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 2 };

    private static volatile bool _stop;
    private static readonly ManualResetEvent _go = new ManualResetEvent(false);
    private static readonly object _emitLock = new object();

    // ---- events ----------------------------------------------------------------
    private static long NowMs()
    {
        return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    private static void Emit(string ev, string fields)
    {
        lock (_emitLock)
        {
            Console.Out.WriteLine("{\"event\":\"" + ev + "\",\"t\":" + NowMs().ToString(CultureInfo.InvariantCulture) +
                (string.IsNullOrEmpty(fields) ? "" : "," + fields) + "}");
            Console.Out.Flush();
        }
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

    private static string Field(string name, string value) { return Quote(name) + ":" + Quote(value); }
    private static string Num(string name, double value)
    {
        return Quote(name) + ":" + value.ToString("0.###", CultureInfo.InvariantCulture);
    }

    // ---- devices -----------------------------------------------------------------
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

    private static string IdOf(IMMDevice d)
    {
        string id;
        return d != null && d.GetId(out id) == 0 ? id : null;
    }

    private static string RoleName(int r) { return r == 0 ? "console" : r == 1 ? "multimedia" : "communications"; }

    private static int RoleIndex(string role)
    {
        if (role == "console") return 0;
        if (role == "multimedia") return 1;
        return 2;
    }

    private static List<IMMDevice> Devices(IMMDeviceEnumerator en, int flow)
    {
        var result = new List<IMMDevice>();
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(flow, ACTIVE, out col) != 0 || col == null) return result;
        uint n;
        col.GetCount(out n);
        for (uint i = 0; i < n; i++)
        {
            IMMDevice d;
            if (col.Item(i, out d) == 0 && d != null) result.Add(d);
        }
        return result;
    }

    /// A device by exact id or by a case-insensitive part of its name; otherwise
    /// the default device for the role.
    private static IMMDevice Find(IMMDeviceEnumerator en, int flow, string match, string role)
    {
        if (!string.IsNullOrEmpty(match))
        {
            IMMDevice exact;
            if (en.GetDevice(match, out exact) == 0 && exact != null) return exact;
            foreach (var d in Devices(en, flow))
                if (NameOf(d).IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) return d;
            return null;
        }
        IMMDevice def;
        return en.GetDefaultAudioEndpoint(flow, RoleIndex(role), out def) == 0 ? def : null;
    }

    private static void List(IMMDeviceEnumerator en)
    {
        for (int flow = 0; flow < 2; flow++)
        {
            var defaults = new Dictionary<string, List<string>>();
            for (int r = 0; r < 3; r++)
            {
                IMMDevice d;
                if (en.GetDefaultAudioEndpoint(flow, r, out d) != 0 || d == null) continue;
                var id = IdOf(d) ?? "";
                if (!defaults.ContainsKey(id)) defaults[id] = new List<string>();
                defaults[id].Add(Quote(RoleName(r)));
            }
            foreach (var d in Devices(en, flow))
            {
                var id = IdOf(d) ?? "";
                var roles = defaults.ContainsKey(id) ? string.Join(",", defaults[id].ToArray()) : "";
                Emit("device", Field("flow", flow == RENDER ? "output" : "input") + "," + Field("name", NameOf(d)) +
                    "," + Field("id", id) + ",\"defaultFor\":[" + roles + "]");
            }
        }
    }

    private static int SetDefault(IMMDeviceEnumerator en, string match, int flow, string roles)
    {
        var d = Find(en, flow, match, "console");
        if (d == null) { Emit("error", Field("message", "no device matches " + match)); return 2; }
        var policy = (IPolicyConfig)new PolicyConfigClient();
        var id = IdOf(d);
        for (int r = 0; r < 3; r++)
        {
            if (roles != "all" && RoleIndex(roles) != r) continue;
            int hr = policy.SetDefaultEndpoint(id, r);
            if (hr != 0)
            {
                Emit("error", Field("message", "SetDefaultEndpoint failed hr=0x" + hr.ToString("x8")));
                return 1;
            }
        }
        Emit("default-set", Field("device", NameOf(d)) + "," + Field("roles", roles));
        return 0;
    }

    private static int Rename(IMMDeviceEnumerator en, string match, int flow, string to)
    {
        var d = Find(en, flow, match, "console");
        if (d == null) { Emit("error", Field("message", "no device matches " + match)); return 2; }
        IPropertyStore ps;
        int hr = d.OpenPropertyStore(2 /* STGM_READWRITE */, out ps);
        if (hr != 0 || ps == null)
        {
            Emit("error", Field("message", "property store not writable (admin needed) hr=0x" + hr.ToString("x8")));
            return 1;
        }
        var before = NameOf(d);
        var value = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(to) };
        var key = PKEY_DeviceDesc;
        hr = ps.SetValue(ref key, ref value);
        if (hr == 0) hr = ps.Commit();
        Marshal.FreeCoTaskMem(value.p);
        if (hr != 0) { Emit("error", Field("message", "rename failed hr=0x" + hr.ToString("x8"))); return 1; }
        Emit("renamed", Field("from", before) + "," + Field("to", NameOf(d)));
        return 0;
    }

    // ---- the far end: a WAV, played like Teams plays a call ------------------------
    private sealed class Wav
    {
        public int Rate;
        public short[] Mono;
    }

    private static Wav ReadWav(string path)
    {
        using (var br = new BinaryReader(File.OpenRead(path)))
        {
            if (new string(br.ReadChars(4)) != "RIFF") throw new InvalidDataException("not a RIFF file");
            br.ReadUInt32();
            if (new string(br.ReadChars(4)) != "WAVE") throw new InvalidDataException("not a WAVE file");
            int channels = 0, rate = 0, bits = 0;
            ushort tag = 0;
            while (br.BaseStream.Position + 8 <= br.BaseStream.Length)
            {
                var id = new string(br.ReadChars(4));
                var size = br.ReadUInt32();
                if (id == "fmt ")
                {
                    tag = br.ReadUInt16();
                    channels = br.ReadUInt16();
                    rate = (int)br.ReadUInt32();
                    br.ReadUInt32();
                    br.ReadUInt16();
                    bits = br.ReadUInt16();
                    if (size > 16) br.ReadBytes((int)size - 16);
                }
                else if (id == "data")
                {
                    if ((tag != WAVE_FORMAT_PCM && tag != WAVE_FORMAT_EXTENSIBLE) || bits != 16 || channels < 1)
                        throw new InvalidDataException("need 16-bit PCM");
                    var bytes = br.ReadBytes((int)Math.Min(size, br.BaseStream.Length - br.BaseStream.Position));
                    int frames = bytes.Length / (2 * channels);
                    var mono = new short[frames];
                    for (int f = 0; f < frames; f++)
                    {
                        int sum = 0;
                        for (int c = 0; c < channels; c++) sum += BitConverter.ToInt16(bytes, (f * channels + c) * 2);
                        mono[f] = (short)(sum / channels);
                    }
                    return new Wav { Rate = rate, Mono = mono };
                }
                else br.ReadBytes((int)size + (int)(size & 1));
            }
        }
        throw new InvalidDataException("no data chunk");
    }

    private static int Play(IMMDeviceEnumerator en, string file, string role, string device, double gainDb,
        float sessionVolume, double lingerSeconds, bool waitGo)
    {
        var wav = ReadWav(file);
        double gain = Math.Pow(10, gainDb / 20.0);
        long position = 0; // frames of the file already handed to the device
        bool announced = false;
        Emit("loaded", Field("file", file) + "," + Num("rate", wav.Rate) + "," + Num("seconds", wav.Mono.Length / (double)wav.Rate));

        while (!_stop)
        {
            var dev = Find(en, RENDER, device, role);
            if (dev == null)
            {
                Emit("error", Field("message", "no output device for " + (device ?? role)));
                if (!announced && waitGo) return 2;
                Thread.Sleep(1000);
                continue;
            }
            var iid = IID_IAudioClient;
            object obj;
            int hr = dev.Activate(ref iid, 1, IntPtr.Zero, out obj);
            if (hr != 0) { Emit("error", Field("message", "activate failed hr=0x" + hr.ToString("x8"))); return 1; }
            var client = (IAudioClient)obj;

            // Our own format (the file's rate, mono, 16-bit); the engine converts. This is
            // what Teams' stream looks like to the audio engine: one app session, shared mode.
            var wfx = new WaveFormatEx
            {
                wFormatTag = WAVE_FORMAT_PCM, nChannels = 1, nSamplesPerSec = (uint)wav.Rate,
                wBitsPerSample = 16, nBlockAlign = 2, nAvgBytesPerSec = (uint)(wav.Rate * 2), cbSize = 0,
            };
            IntPtr pFormat = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WaveFormatEx)));
            Marshal.StructureToPtr(wfx, pFormat, false);
            hr = client.Initialize(SHARE_MODE_SHARED, STREAMFLAGS_AUTOCONVERTPCM | STREAMFLAGS_SRC_DEFAULT_QUALITY,
                2000000L /* 200 ms */, 0, pFormat, IntPtr.Zero);
            Marshal.FreeHGlobal(pFormat);
            if (hr != 0) { Emit("error", Field("message", "initialize failed hr=0x" + hr.ToString("x8"))); return 1; }

            if (sessionVolume >= 0)
            {
                var iidVol = IID_ISimpleAudioVolume;
                object volObj;
                if (client.GetService(ref iidVol, out volObj) == 0 && volObj != null)
                {
                    var ctx = Guid.Empty;
                    ((ISimpleAudioVolume)volObj).SetMasterVolume(sessionVolume, ref ctx);
                }
            }

            uint bufferFrames;
            client.GetBufferSize(out bufferFrames);
            var iidRender = IID_IAudioRenderClient;
            object renderObj;
            hr = client.GetService(ref iidRender, out renderObj);
            if (hr != 0) { Emit("error", Field("message", "render client hr=0x" + hr.ToString("x8"))); return 1; }
            var render = (IAudioRenderClient)renderObj;

            if (!announced)
            {
                Emit("ready", Field("device", NameOf(dev)) + "," + Field("role", device == null ? role : "named") +
                    "," + Num("bufferMs", bufferFrames * 1000.0 / wav.Rate));
                if (waitGo)
                {
                    while (!_stop && !_go.WaitOne(100)) { }
                    if (_stop) { client.Stop(); return 0; }
                }
            }

            hr = Fill(client, render, bufferFrames, wav, gain, ref position);
            if (hr == 0) hr = client.Start();
            if (hr == 0 && !announced)
            {
                // The first sample leaves now (plus the engine's ~10-20 ms): the
                // verifier uses this to place the far end on the recording's clock.
                Emit("playing", Field("device", NameOf(dev)) + "," + Num("frames", wav.Mono.Length));
                announced = true;
            }
            else if (hr == 0)
            {
                Emit("resumed", Field("device", NameOf(dev)) + "," + Num("positionSeconds", position / (double)wav.Rate));
            }

            long nextReport = position + wav.Rate * 5;
            while (hr == 0 && !_stop)
            {
                Thread.Sleep(10);
                hr = Fill(client, render, bufferFrames, wav, gain, ref position);
                if (position >= nextReport)
                {
                    Emit("position", Num("seconds", position / (double)wav.Rate));
                    nextReport = position + wav.Rate * 5;
                }
                if (position >= wav.Mono.Length)
                {
                    uint padding;
                    while (client.GetCurrentPadding(out padding) == 0 && padding > 0 && !_stop) Thread.Sleep(10);
                    break;
                }
            }
            client.Stop();
            if (hr == AUDCLNT_E_DEVICE_INVALIDATED)
            {
                // A headset unplugged mid-call: Teams follows to the next device, so do we.
                Emit("rebind", Num("positionSeconds", position / (double)wav.Rate));
                Thread.Sleep(300);
                continue;
            }
            if (hr != 0) { Emit("error", Field("message", "render failed hr=0x" + hr.ToString("x8"))); return 1; }
            break;
        }

        if (!_stop) Emit("finished", Num("seconds", position / (double)wav.Rate));
        var lingerUntil = DateTime.UtcNow.AddSeconds(lingerSeconds);
        while (!_stop && DateTime.UtcNow < lingerUntil) Thread.Sleep(50);
        return 0;
    }

    private static int Fill(IAudioClient client, IAudioRenderClient render, uint bufferFrames, Wav wav,
        double gain, ref long position)
    {
        uint padding;
        int hr = client.GetCurrentPadding(out padding);
        if (hr != 0) return hr;
        uint free = bufferFrames - padding;
        if (free == 0) return 0;
        IntPtr data;
        hr = render.GetBuffer(free, out data);
        if (hr != 0) return hr;
        var block = new short[free];
        for (int i = 0; i < free; i++)
        {
            long at = position + i;
            if (at >= wav.Mono.Length) break;
            double v = wav.Mono[at] * gain;
            block[i] = (short)Math.Max(-32768, Math.Min(32767, v));
        }
        Marshal.Copy(block, 0, data, (int)free);
        position += free;
        return render.ReleaseBuffer(free, 0);
    }

    // ---- Teams' own microphone -----------------------------------------------------
    /// Opens a microphone and reads it like a call would (the data is discarded), so
    /// Windows lists an active ms-teams session on that device.
    private static void HoldMic(IMMDeviceEnumerator en, string role, string device)
    {
        while (!_stop)
        {
            var dev = Find(en, CAPTURE, device, role);
            if (dev == null)
            {
                Emit("mic-missing", Field("match", device ?? role));
                return;
            }
            var iid = IID_IAudioClient;
            object obj;
            if (dev.Activate(ref iid, 1, IntPtr.Zero, out obj) != 0) { Emit("mic-error", Field("message", "activate")); return; }
            var client = (IAudioClient)obj;
            IntPtr pFormat;
            if (client.GetMixFormat(out pFormat) != 0) { Emit("mic-error", Field("message", "mix format")); return; }
            int hr = client.Initialize(SHARE_MODE_SHARED, 0, 2000000L, 0, pFormat, IntPtr.Zero);
            Marshal.FreeCoTaskMem(pFormat);
            if (hr != 0) { Emit("mic-error", Field("message", "initialize hr=0x" + hr.ToString("x8"))); return; }
            var iidCap = IID_IAudioCaptureClient;
            object capObj;
            if (client.GetService(ref iidCap, out capObj) != 0) { Emit("mic-error", Field("message", "capture client")); return; }
            var capture = (IAudioCaptureClient)capObj;
            if (client.Start() != 0) { Emit("mic-error", Field("message", "start")); return; }
            Emit("mic-open", Field("device", NameOf(dev)));
            while (!_stop)
            {
                Thread.Sleep(10);
                uint packet;
                hr = capture.GetNextPacketSize(out packet);
                while (hr == 0 && packet > 0)
                {
                    IntPtr data;
                    uint frames, flags;
                    ulong devicePos, qpc;
                    hr = capture.GetBuffer(out data, out frames, out flags, out devicePos, out qpc);
                    if (hr != 0) break;
                    capture.ReleaseBuffer(frames);
                    hr = capture.GetNextPacketSize(out packet);
                }
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED) break;
                if (hr != 0) { Emit("mic-error", Field("message", "read hr=0x" + hr.ToString("x8"))); break; }
            }
            client.Stop();
            if (hr != AUDCLNT_E_DEVICE_INVALIDATED) break;
            Emit("mic-rebind", "");
            Thread.Sleep(300);
        }
        Emit("mic-closed", "");
    }

    // ---- main -------------------------------------------------------------------------
    private static int Main(string[] args)
    {
        try { Console.OutputEncoding = new System.Text.UTF8Encoding(false); } catch { /* redirected */ }

        string play = null, role = "communications", device = null, micRole = "communications", micDevice = null;
        string setDefault = null, rename = null, renameTo = null, flow = "render", roles = "all";
        bool list = false, holdMic = false, waitGo = false;
        double gainDb = 0, linger = 0;
        float sessionVolume = -1;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            bool hasValue = i + 1 < args.Length;
            if (a == "--list") list = true;
            else if (a == "--play" && hasValue) play = args[++i];
            else if (a == "--role" && hasValue) role = args[++i].ToLowerInvariant();
            else if (a == "--device" && hasValue) device = args[++i];
            else if (a == "--gain-db" && hasValue) double.TryParse(args[++i], NumberStyles.Float, CultureInfo.InvariantCulture, out gainDb);
            else if (a == "--session-volume" && hasValue) float.TryParse(args[++i], NumberStyles.Float, CultureInfo.InvariantCulture, out sessionVolume);
            else if (a == "--linger" && hasValue) double.TryParse(args[++i], NumberStyles.Float, CultureInfo.InvariantCulture, out linger);
            else if (a == "--hold-mic") holdMic = true;
            else if (a == "--mic-role" && hasValue) micRole = args[++i].ToLowerInvariant();
            else if (a == "--mic-device" && hasValue) micDevice = args[++i];
            else if (a == "--wait-go") waitGo = true;
            else if (a == "--set-default" && hasValue) setDefault = args[++i];
            else if (a == "--rename" && hasValue) rename = args[++i];
            else if (a == "--to" && hasValue) renameTo = args[++i];
            else if (a == "--flow" && hasValue) flow = args[++i].ToLowerInvariant();
            else if (a == "--roles" && hasValue) roles = args[++i].ToLowerInvariant();
            else { Emit("error", Field("message", "unknown argument " + a)); return 2; }
        }
        int flowIndex = flow == "capture" || flow == "input" ? CAPTURE : RENDER;
        var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();

        try
        {
            if (list) { List(en); return 0; }
            if (setDefault != null) return SetDefault(en, setDefault, flowIndex, roles);
            if (rename != null)
            {
                if (string.IsNullOrEmpty(renameTo)) { Emit("error", Field("message", "--to is required")); return 2; }
                return Rename(en, rename, flowIndex, renameTo);
            }
            if (play == null && !holdMic) { Emit("error", Field("message", "nothing to do: --list, --play or --hold-mic")); return 2; }

            // stdin: "go" starts a --wait-go playback, "stop" or EOF ends everything,
            // so the simulator can never outlive the harness that started it.
            var reader = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        line = line.Trim();
                        if (line == "go") _go.Set();
                        else if (line == "stop") break;
                    }
                }
                catch { /* stdin gone */ }
                _stop = true;
            });
            reader.IsBackground = true;
            reader.Start();

            Thread mic = null;
            if (holdMic)
            {
                mic = new Thread(() =>
                {
                    try { HoldMic((IMMDeviceEnumerator)new MMDeviceEnumerator(), micRole, micDevice); }
                    catch (Exception ex) { Emit("mic-error", Field("message", ex.GetType().Name + ": " + ex.Message)); }
                });
                mic.IsBackground = true;
                mic.Start();
            }

            int code = 0;
            if (play != null)
            {
                code = Play(en, play, role, device, gainDb, sessionVolume, linger, waitGo);
                _stop = true;
            }
            else
            {
                while (!_stop) Thread.Sleep(50);
            }
            if (mic != null) mic.Join(2000);
            Emit("stopped", Num("code", code));
            return code;
        }
        catch (Exception ex)
        {
            Emit("error", Field("message", ex.GetType().Name + ": " + ex.Message));
            return 1;
        }
    }
}
