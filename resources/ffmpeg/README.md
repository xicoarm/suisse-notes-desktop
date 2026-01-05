# FFmpeg Binaries

Place FFmpeg binaries here for production builds.

## Current Structure
```
resources/ffmpeg/
├── ffmpeg.exe      # Windows (current)
├── ffprobe.exe     # Windows (current)
└── darwin/         # macOS (add when ready)
    └── ffmpeg
```

## Windows (Current)
- `ffmpeg.exe` ✓
- `ffprobe.exe` ✓

## macOS (When Ready)
Create a `darwin/` folder and add:
- `darwin/ffmpeg` (universal binary for x64 + arm64)

### Download Sources

**Windows:**
- https://github.com/BtbN/FFmpeg-Builds/releases (recommended)
- https://www.gyan.dev/ffmpeg/builds/

**macOS:**
- https://evermeet.cx/ffmpeg/ (pre-built universal binaries)
- Or build from source with: `./configure --enable-cross-compile && make`

### macOS Setup Steps
1. Download FFmpeg for macOS (universal binary recommended)
2. Create folder: `resources/ffmpeg/darwin/`
3. Copy `ffmpeg` binary to `resources/ffmpeg/darwin/ffmpeg`
4. Make executable: `chmod +x resources/ffmpeg/darwin/ffmpeg`
5. Create `src-electron/icons/icon.icns` (convert from PNG)
6. Enable macOS build in `.github/workflows/release.yml`
