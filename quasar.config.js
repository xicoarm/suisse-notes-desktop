/* eslint-env node */

// Configuration for your app
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-file

export default function (ctx) {
  return {
    eslint: {
      warnings: true,
      errors: true
    },

    boot: [
      'axios',
      'i18n',
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
      sassVariables: 'src/css/quasar.variables.scss'
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
          // Only set publisherName when code signing is available
          // Without this, electron-updater won't require signature verification
          ...(process.env.CSC_LINK ? { publisherName: 'Suisse Notes' } : {}),
          // Code signing - enable when certificate is available
          // Set environment variables in CI/CD:
          //   CSC_LINK: path to .pfx certificate file
          //   CSC_KEY_PASSWORD: certificate password
          signAndEditExecutable: !!process.env.CSC_LINK
        },
        nsis: {
          oneClick: true,  // Silent auto-updates (no wizard prompts)
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
          notarize: false
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
            from: 'resources/ffmpeg',
            to: 'ffmpeg',
            filter: ['**/*']
          }
        ],
        // Extract icons from asar so they can be loaded natively for taskbar/tray
        asarUnpack: [
          '**/icons/**'
        ]
      }
    },

    bex: {
      contentScripts: ['my-content-script']
    }
  };
}
