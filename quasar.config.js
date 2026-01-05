/* eslint-env node */

// Configuration for your app
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-file

export default function (/* ctx */) {
  return {
    eslint: {
      warnings: true,
      errors: true
    },

    boot: [
      'axios',
      'i18n'
    ],

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
      hideSplashscreen: true
    },

    electron: {
      inspectPort: 5858,

      bundler: 'builder',

      builder: {
        appId: 'com.suisse-notes.desktop',
        productName: 'Suisse Notes',

        // GitHub Releases for auto-updates
        publish: {
          provider: 'github',
          owner: 'xicoarm',
          repo: 'suisse-notes-desktop',
          releaseType: 'release',
          private: true
        },

        win: {
          target: 'nsis',
          signAndEditExecutable: false  // Skip code signing (no certificate yet)
        },
        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true
          // installerIcon: 'src-electron/icons/icon.ico' // Add custom icon later
        },
        extraResources: [
          {
            from: 'resources/ffmpeg',
            to: 'ffmpeg',
            filter: ['**/*']
          }
        ]
      }
    },

    bex: {
      contentScripts: ['my-content-script']
    }
  };
}
