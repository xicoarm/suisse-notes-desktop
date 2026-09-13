/* eslint-env node */

// Configuration for your app
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-file

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Native mobile version (Android versionName; the iOS MARKETING_VERSION is kept
// in lock-step by the release runbook). Falls back to package.json only if the
// gradle file cannot be read. ESM file: no __dirname, resolve via import.meta.url.
function mobileAppVersion() {
  try {
    const fs = require('fs');
    const gradle = fs.readFileSync(new URL('./src-capacitor/android/app/build.gradle', import.meta.url), 'utf8');
    const m = /versionName\s+"([^"]+)"/.exec(gradle);
    if (m) return m[1];
  } catch (e) { /* fall through */ }
  return require('./package.json').version;
}

export default function (ctx) {
  const isElectronE2EBuild = ctx.mode.electron && process.env.SUISSE_E2E_HOOKS === '1';
  let testApiOrigin = null;
  if (isElectronE2EBuild) {
    let apiUrl;
    try { apiUrl = new URL(process.env.VITE_API_URL); } catch (_) { /* rejected below */ }
    if (!apiUrl || apiUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname)) {
      throw new Error('Electron E2E builds require VITE_API_URL to point to a local mock backend');
    }
    testApiOrigin = apiUrl.origin;
  }
  return {
    eslint: {
      warnings: true,
      errors: true
    },

    boot: [
      // Mobile: Sentry boots FIRST so errors in the other boot files are
      // captured (desktop keeps its established order).
      ctx.mode.capacitor ? 'sentry' : '',
      'axios',
      'i18n',
      ctx.mode.electron ? 'sentry' : '',
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
      env: {
        // Mobile release name for Sentry, known at build time (the same value
        // the source maps are uploaded under).
        MOBILE_APP_VERSION: ctx.mode.capacitor ? mobileAppVersion() : '',
        // Forward the mock API override for dev and explicitly gated E2E bundles.
        // Ordinary production/release builds retain the production configuration.
        ...((ctx.dev || isElectronE2EBuild) && process.env.VITE_API_URL ? { VITE_API_URL: process.env.VITE_API_URL } : {})
      },
      // Enable source maps in CI for Sentry (when SENTRY_AUTH_TOKEN is set)
      ...(process.env.SENTRY_AUTH_TOKEN && ctx.mode.capacitor ? { sourcemap: true } : {}),
      extendViteConf(viteConf) {
        if (isElectronE2EBuild) {
          viteConf.plugins = viteConf.plugins || [];
          viteConf.plugins.push({
            name: 'suisse-e2e-loopback-csp',
            transformIndexHtml: {
              order: 'post',
              handler(html) {
                // Bundled renderer calls must reach the same mock as the main
                // process. Keep index.html and every production CSP unchanged.
                const directive = /\bconnect-src\s+[^;"]+/g;
                if (html.match(directive)?.length !== 1) throw new Error('Expected one connect-src directive in the Electron E2E HTML');
                return html.replace(directive, value => `${value} ${testApiOrigin}`);
              }
            }
          });
        }
        // Upload source maps to Sentry during CI mobile builds
        if (process.env.SENTRY_AUTH_TOKEN && ctx.mode.capacitor) {
          const { sentryVitePlugin } = require('@sentry/vite-plugin');
          viteConf.plugins = viteConf.plugins || [];
          viteConf.plugins.push(
            sentryVitePlugin({
              org: process.env.SENTRY_ORG || 'suisse-it-gmbh',
              project: process.env.SENTRY_PROJECT || 'capacitor',
              authToken: process.env.SENTRY_AUTH_TOKEN,
              // MUST match the runtime release name in src/boot/sentry.js, which
              // is the NATIVE app version (App.getInfo().version = Android
              // versionName / iOS MARKETING_VERSION, e.g. 3.9.37). package.json
              // carries the DESKTOP version (4.6.0): the plugin created phantom
              // releases ch.suissenotes.mobile@4.4.1 ... @4.6.0 (zero events)
              // while every mobile event comes from @3.9.x.
              release: {
                name: `ch.suissenotes.mobile@${mobileAppVersion()}`,
              },
              sourcemaps: {
                // Quasar writes the capacitor web build to src-capacitor/www
                // (capacitor.config webDir "www"); the previous glob
                // './dist/capacitor/www/**' matched nothing, so every CI build
                // logged "Didn't find any matching sources for debug ID upload"
                // and no mobile stack trace was ever symbolicated.
                assets: ['./src-capacitor/www/**'],
                // Never ship .map files inside the APK/IPA.
                filesToDeleteAfterUpload: ['./src-capacitor/www/**/*.map'],
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
      // App identifier for mobile stores (no dashes allowed in Java package names).
      // The appId is a MACHINE IDENTIFIER (store identity) — it must NEVER change
      // across the rebrand; only the display appName carries the new brand.
      appId: 'ch.suissenotes.mobile',
      appName: 'Suisse Meets',
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
        // appId is the app's OS-level identity (NSIS upgrade GUID, macOS TCC
        // permissions). It must NEVER change across the rebrand — a new appId
        // would install side-by-side on Windows and reset mic/screen permissions
        // on macOS. Only the display name (productName) carries the new brand.
        appId: 'com.suisse-notes.desktop',
        productName: 'Suisse Meets',
        icon: 'src-electron/icons/icon',

        // Custom URL scheme used by the SSO bridge: the system browser opens
        // /api/auth/microsoft/login?client=desktop, and the backend callback
        // hands the token back via suissenotes://auth/callback?token=...&user=...
        protocols: [
          // Scheme stays 'suissenotes' — the backend's OAuth callback redirects
          // to it and every installed client registered it. Display name only.
          { name: 'Suisse Meets SSO', schemes: ['suissenotes'] }
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
          // MUST stay true: this flag also gates the rcedit step that embeds
          // the icon + version metadata into the exe. With it false, every
          // build shipped with Electron's default atom icon on the executable
          // (and "Electron" file properties). No signing happens here anyway —
          // CI builds with -P never and no certs; SSL.com eSigner signs the
          // finished installer afterwards, so edit-then-sign is the right order.
          signAndEditExecutable: true
        },
        nsis: {
          oneClick: true,  // Silent auto-updates (no wizard prompts)
          perMachine: false,  // Install per-user (no admin rights needed)
          allowElevation: false,  // Prevent silent UAC relaunch that causes "nothing happens" on first run
          allowToChangeInstallationDirectory: false,  // Required for oneClick
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: 'Suisse Meets',
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
            NSAudioCaptureUsageDescription: 'Suisse Meets captures system audio to include meeting participants in the transcription.'
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
          }
          // NOTE: resources/sysloopback (the Windows loopback helper) is
          // deliberately NOT bundled yet. It is built and hardware-verified but
          // not wired into the recording pipeline, so shipping it would only add
          // an unused binary to the installer and to the signing surface.
          // Bundle it in the same change that starts spawning it.
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
