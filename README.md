# Simple Meeting Recorder

A simple Electron desktop application for recording meetings and uploading them to a custom API.

## Features

- **User Authentication**: Login with username/password against your custom API
- **Audio Recording**: Record meetings up to 5 hours using chunked WebM format
- **Resumable Uploads**: Upload recordings using TUS protocol for reliable, resumable uploads
- **Progress Tracking**: Real-time progress display for both recording and uploads

## Prerequisites

- Node.js 18+
- npm or yarn
- FFmpeg (included in resources for production builds)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. For development, you'll need FFmpeg installed on your system. Download from https://ffmpeg.org/download.html

3. Configure your API endpoints in the Settings page when you run the app.

## Development

```bash
# Start development server with hot reload
npm run dev
```

## Build

```bash
# Build for production
npm run build
```

The built application will be in `dist/electron/`.

## Configuration

The application requires two API endpoints:

### Authentication API
- Endpoint: `{authApiUrl}/login`
- Method: POST
- Body: `{ username, password }`
- Response: `{ token, user }`

### Upload API (TUS Protocol)
- Endpoint: `{uploadApiUrl}/upload`
- Headers: `Authorization: Bearer {token}`
- Metadata: filename, filetype, recordId, duration

## Technology Stack

- **Frontend**: Vue 3 + Quasar Framework
- **Desktop**: Electron
- **State Management**: Pinia
- **Audio Processing**: fluent-ffmpeg
- **File Upload**: tus-js-client (resumable uploads)
- **Storage**: electron-store (encrypted local storage)

## Project Structure

```
simple-meeting-recorder/
├── src/
│   ├── components/         # Vue components
│   ├── composables/        # Vue composables (useRecorder)
│   ├── pages/              # Page components
│   ├── stores/             # Pinia stores
│   ├── router/             # Vue Router config
│   └── boot/               # Quasar boot files
├── src-electron/
│   ├── electron-main.js    # Main Electron process
│   └── electron-preload.js # Preload script (IPC bridge)
└── resources/
    └── ffmpeg/             # FFmpeg binaries for production
```

## License

MIT
