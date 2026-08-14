/* eslint-env node */

// Configuration for your app
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-file

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default function (ctx) {
  return {
    eslint: {
      warnings: true,
      errors: true
    },

    boot: [
      'axios',
      'i18n',
      // Load Sentry for both desktop (Electron renderer) and mobile (Capacitor)
      (ctx.mode.capacitor || ctx.mode.electron) ? 'sentry' : '',
      // Load lifecycle boot file only on Capacitor (mobile)
      ctx.mode.capacitor ? 'lifecycle' : ''
    ].filter(Boolean),

    css: [
      'app.scss'
    ],

    extras: [
      // Using Inter font via CSS import instead of roboto-font
      'material-icons'
    ],

    build: {
      target: {
        browser: ['es2019', 'edge88', 'firefox78', 'chrome87', 'safari13.1'],
        node: 'node20'
      },
      vueRouterMode: 'hash',
      // Use our custom Quasar variables for brand colors
      sassVariables: 'src/css/quasar.variables.scss',
      // DEV ONLY: forward the API override into the renderer so the e2e
      // harness can point the whole app (renderer + main) at its local mock
      // backend. Never applied to production builds.
      ...(ctx.dev && process.env.VITE_API_URL
        ? { env: { VITE_API_URL: process.env.VITE_API_URL } }
        : {}),
      // Enable source maps in CI for Sentry (when SENTRY_AUTH_TOKEN is set)
      ...(process.env.SENTRY_AUTH_TOKEN && ctx.mode.capacitor ? { sourcemap: true } : {}),
      extendViteConf(viteConf) {
        // Upload source maps to Sentry during CI mobile builds
        if (process.env.SENTRY_AUTH_TOKEN && ctx.mode.capacitor) {
          const { sentryVitePlugin } = require('@sentry/vite-plugin');
          viteConf.plugins = viteConf.plugins || [];
          viteConf.plugins.push(
            sentryVitePlugin({
              org: process.env.SENTRY_ORG || 'suisse-it-gmbh',
              project: process.env.SENTRY_PROJECT || 'capacitor',
              authToken: process.env.SENTRY_AUTH_TOKEN,
              release: {
                name: `ch.suissenotes.mobile@${require('./package.json').version}`,
              },
              sourcemaps: {
                assets: './dist/capacitor/www/**',
              },
            })
          );
        }
        // Desktop source map upload: TODO — add once Sentry 'electron' project is verified
      }
    },

    devServer: {
      open: false
    },

    framework: {
      config: {},
      plugins: [
        'Notify',
        'Loading',
        'Dialog'
      ]
    },

    animations: [],

    ssr: {
      pwa: false,
      prodPort: 3000,
      middlewares: [
        'render'
      ]
    },

    pwa: {
      workboxMode: 'generateSW'
    },

    cordova: {},

    capacitor: {
      hideSplashscreen: true,
      // Capacitor CLI version (must be installed)
      // version: 6,
      // App identifier for mobile stores (no dashes allowed in Java package names)
      appId: 'ch.suissenotes.mobile',
      appName: 'Suisse Notes',
      // iOS-specific settings
      ios: {
        // Enable background audio recording
        appendUserAgent: 'SuisseNotes-iOS'
      },
      // Android-specific settings
      android: {
        appendUserAgent: 'SuisseNotes-Android'
      }
    },

    electron: {
      inspectPort: 5858,

      bundler: 'builder',

      builder: {
        appId: 'com.suisse-notes.desktop',
        productName: 'Suisse Notes',
        icon: 'src-electron/icons/icon',

        // Custom URL scheme used by the SSO bridge: the system browser opens
        // /api/auth/microsoft/login?client=desktop, and the backend callback
        // hands the token back via suissenotes://auth/callback?token=...&user=...
        protocols: [
          { name: 'Suisse Notes SSO', schemes: ['suissenotes'] }
        ],

        // GitHub Releases for auto-updates
        // This config is required to generate latest-mac.yml / latest.yml
        // Use -P never CLI flag to prevent upload (macOS uploads after notarization)
        publish: {
          provider: 'github',
          owner: 'xicoarm',
          repo: 'suisse-notes-desktop',
          releaseType: 'release'
        },

        win: {
          target: 'nsis',
          icon: 'src-electron/icons/icon.ico',
          publisherName: 'Suisse IT GmbH',
          // Signing handled post-build by SSL.com eSigner in CI
          signAndEditExecutable: false
        },
        nsis: {
          oneClick: true,  // Silent auto-updates (no wizard prompts)
          perMachine: false,  // Install per-user (no admin rights needed)
          allowElevation: false,  // Prevent silent UAC relaunch that causes "nothing happens" on first run
          allowToChangeInstallationDirectory: false,  // Required for oneClick
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: 'Suisse Notes',
          installerIcon: 'src-electron/icons/icon.ico',
          uninstallerIcon: 'src-electron/icons/icon.ico',
          installerHeaderIcon: 'src-electron/icons/icon.ico'
        },
        mac: {
          target: [
            { target: 'dmg', arch: ['x64', 'arm64'] },
            { target: 'zip', arch: ['x64', 'arm64'] }
          ],
          icon: 'src-electron/icons/icon.icns',
          category: 'public.app-category.productivity',
          hardenedRuntime: true,
          gatekeeperAssess: false,
          entitlements: 'build/entitlements.mac.plist',
          entitlementsInherit: 'build/entitlements.mac.plist',
          forceCodeSigning: !!process.env.CSC_KEYCHAIN,
          // Notarization is handled manually via xcrun notarytool in CI
          notarize: false,
          // Prevent macOS from silently terminating the app during long recordings
          extendInfo: {
            NSSupportsAutomaticTermination: false,
            NSSupportsSuddenTermination: false,
            // Required for AudioTee system audio capture (macOS 14.2+)
            NSAudioCaptureUsageDescription: 'Suisse Notes captures system audio to include meeting participants in the transcription.'
          }
        },
        dmg: {
          contents: [
            { x: 130, y: 220 },
            { x: 410, y: 220, type: 'link', path: '/Applications' }
          ]
        },
        linux: {
          target: ['AppImage', 'deb'],
          icon: 'src-electron/icons',
          category: 'AudioVideo'
        },
        extraResources: [
          {
            from: 'resources/ffmpeg/${os}-${arch}',
            to: 'ffmpeg',
            filter: ['**/*']
          },
          {
            from: 'resources/audiotee',
            to: 'audiotee',
            filter: ['**/*']
          },
          {
            // Windows system-audio loopback helper. Ships the built exe only —
            // the C# source stays in the repo but must not go into the package.
            from: 'resources/sysloopback/win-x64',
            to: 'sysloopback',
            filter: ['**/*.exe']
          }
        ],
        // Extract icons from asar so they can be loaded natively for taskbar/tray
        asarUnpack: [
          '**/icons/**',
          // win-ca shells out to this bundled exe to read the Windows trust
          // store; child_process cannot execute it from inside app.asar.
          // (macOS mac-ca uses the system `security` CLI — no unpacking needed.)
          '**/win-ca/lib/roots.exe'
        ]
      }
    },

    bex: {
      contentScripts: ['my-content-script']
    }
  };
}
