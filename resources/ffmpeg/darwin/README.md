# macOS FFmpeg Binary

Place the FFmpeg universal binary here for macOS builds.

## Download Instructions

1. Visit https://evermeet.cx/ffmpeg/
2. Download the latest FFmpeg universal binary (supports both Intel and Apple Silicon)
3. Extract and copy the `ffmpeg` binary to this folder
4. Ensure the file is named exactly `ffmpeg` (no extension)

## After Adding the Binary

```bash
# Make it executable (if not already)
chmod +x ffmpeg

# Verify it works
./ffmpeg -version
```

## Expected File Structure

```
resources/ffmpeg/darwin/
├── README.md  (this file)
└── ffmpeg     (the binary - YOU MUST ADD THIS)
```

## Note

The binary is not included in the repository due to its size (~80MB).
You must download and add it manually before enabling macOS builds.
