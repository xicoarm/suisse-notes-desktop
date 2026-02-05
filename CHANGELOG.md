# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [3.7.26](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.25...v3.7.26) (2026-02-05)


### Bug Fixes

* add extensive debugging to macOS filename verification step ([3f3c08e](https://github.com/xicoarm/suisse-notes-desktop/commit/3f3c08e2a69f769d7a9b9c86df70d0653d46f33c))

### [3.7.25](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.24...v3.7.25) (2026-02-05)


### Bug Fixes

* robust filename verification in macOS release workflow ([cd545d8](https://github.com/xicoarm/suisse-notes-desktop/commit/cd545d86bdd701ba30d2cbb2d26fc38e7d34dd61))

### [3.7.24](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.23...v3.7.24) (2026-02-05)


### Bug Fixes

* prevent mobile workflow from triggering on desktop-only changes ([72b49f1](https://github.com/xicoarm/suisse-notes-desktop/commit/72b49f1090d38a69ca01118f1fda46215c35be55))
* rename macOS artifacts to match latest-mac.yml for auto-update ([583d368](https://github.com/xicoarm/suisse-notes-desktop/commit/583d36878e1487ad67ac65fd478b952bc9ccdd89))

### [3.7.23](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.22...v3.7.23) (2026-02-05)


### Bug Fixes

* add auto-update validation guards to release workflow ([25d37e1](https://github.com/xicoarm/suisse-notes-desktop/commit/25d37e17c6f7a4fd2076256dfaabac11142d2df5))
* system audio volume indicator always zero and clarify permission notice ([8f6b703](https://github.com/xicoarm/suisse-notes-desktop/commit/8f6b7034141acdc3904c119ece3d57d46fd20788))

### [3.7.22](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.21...v3.7.22) (2026-02-05)


### Bug Fixes

* use -P never CLI flag for macOS build to generate latest-mac.yml ([3572d7d](https://github.com/xicoarm/suisse-notes-desktop/commit/3572d7dc9096194707ffc2544691689604288047))
* use PUBLISH=never env var for electron-builder ([01c2923](https://github.com/xicoarm/suisse-notes-desktop/commit/01c29236de88e2c95b67d5096049de42a7071641))

### [3.7.12](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.11...v3.7.12) (2026-02-04)


### Bug Fixes

* hide header on mobile and fix status bar icon visibility on iOS ([dbcada3](https://github.com/xicoarm/suisse-notes-desktop/commit/dbcada314454ed2bcfd7ec2764b3968980dc445b))

### [3.7.10](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.9...v3.7.10) (2026-02-04)


### Bug Fixes

* skip TUS and checksum on mobile to eliminate upload delay ([7138550](https://github.com/xicoarm/suisse-notes-desktop/commit/7138550356edd006e6a5608098bdc2f0dfb9c161))

### [3.7.9](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.5...v3.7.9) (2026-02-04)


### Bug Fixes

* guard electronAPI.recording in AudioPlayback for mobile ([f99296c](https://github.com/xicoarm/suisse-notes-desktop/commit/f99296c71b7e87989e118c4eebf22683615856ee))

### [3.7.8](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.7...v3.7.8) (2026-02-04)


### Bug Fixes

* mobile recording MIME type, error UI, pre-upload history, and re-upload ([d312f93](https://github.com/xicoarm/suisse-notes-desktop/commit/d312f932b91ad9e2481f56cce7024d9c4d947af2))

### [3.7.4](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.3...v3.7.4) (2026-02-03)


### Features

* add mic mute button, dynamic system audio toggle, fix system audio state on navigation ([e6fb0c6](https://github.com/xicoarm/suisse-notes-desktop/commit/e6fb0c6cff1b5d17586a71178dc0304aec83c465))

### [3.7.3](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.2...v3.7.3) (2026-02-02)


### Bug Fixes

* default system audio to off each session and add auth security checks ([81076f1](https://github.com/xicoarm/suisse-notes-desktop/commit/81076f18e03f6cbd061c7f17d4eddec943954175))
* remove silence auto-pause, fix system audio toggle, add recording indicator ([c15a2bf](https://github.com/xicoarm/suisse-notes-desktop/commit/c15a2bf7f07fc053a3ae208121a91690643efa1a))

### [3.7.2](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.1...v3.7.2) (2026-01-27)


### Bug Fixes

* switch from semantic-release to tag-based releases ([5b3577b](https://github.com/xicoarm/suisse-notes-desktop/commit/5b3577bcbadc254136c424bbd1ef2f6792a11647))

### [3.7.1](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.0...v3.7.1) (2026-01-27)


### Features

* add mob_ prefix to mobile device ID for trial tracking ([8a0416f](https://github.com/xicoarm/suisse-notes-desktop/commit/8a0416ffedab351563f6d478af03a7ebb1c0e35e))

## [3.7.0](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.6.1...v3.7.0) (2026-01-27)


### Features

* use hardware-based device ID for trial abuse prevention ([b748182](https://github.com/xicoarm/suisse-notes-desktop/commit/b7481826d5e315ae7d847a9aea919f4db8e0dea6))

### [3.6.1](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.5.1...v3.6.1) (2026-01-27)


### Features

* add i18n translations for minutes feature and global display ([c0b6a5c](https://github.com/xicoarm/suisse-notes-desktop/commit/c0b6a5c1ef76ad4314aa3fa669bba9ccc8e0f7ea))


### Code Refactoring

* simplify minutes display UI ([fe9c718](https://github.com/xicoarm/suisse-notes-desktop/commit/fe9c718dd9e9b604cd4cfdc9184f4f3abc907d89))

# [3.6.0](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.5.1...v3.6.0) (2026-01-27)


### Features

* add i18n translations for minutes feature and global display ([c0b6a5c](https://github.com/xicoarm/suisse-notes-desktop/commit/c0b6a5c1ef76ad4314aa3fa669bba9ccc8e0f7ea))

## [3.5.1](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.5.0...v3.5.1) (2026-01-27)


### Bug Fixes

* download ffmpeg at build time instead of using LFS ([edaf9ae](https://github.com/xicoarm/suisse-notes-desktop/commit/edaf9ae9f74ea987f2a9e37027e4dfc05b459cb9))

# [3.5.0](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.14...v3.5.0) (2026-01-27)


### Features

* implement free minutes feature for transcription limits ([ba4e700](https://github.com/xicoarm/suisse-notes-desktop/commit/ba4e70095af61d4f13c00b7ad9ae7c405060e1cf))

## [3.4.14](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.13...v3.4.14) (2026-01-26)


### Bug Fixes

* test release for auto-update verification ([b18ed40](https://github.com/xicoarm/suisse-notes-desktop/commit/b18ed40be55d3f84ea7907e22cba64b4ffa35c6d))

## [3.4.13](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.12...v3.4.13) (2026-01-26)


### Bug Fixes

* enable oneClick installer for silent auto-updates ([c6ff0b9](https://github.com/xicoarm/suisse-notes-desktop/commit/c6ff0b904b6a421fd77b2c2caae9042e9e85caf0))

## [3.4.12](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.11...v3.4.12) (2026-01-26)


### Bug Fixes

* use nativeImage for window icon to work in packaged app ([11992f3](https://github.com/xicoarm/suisse-notes-desktop/commit/11992f314b20c478f9d582904fd86261364f12b0))

## [3.4.11](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.10...v3.4.11) (2026-01-26)


### Bug Fixes

* silent auto-updates and correct Windows app name ([1d8e6b3](https://github.com/xicoarm/suisse-notes-desktop/commit/1d8e6b389405ce4e37b591e8287870e44d64b421))

## [3.4.10](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.9...v3.4.10) (2026-01-26)


### Bug Fixes

* **android:** align Java and Kotlin JVM targets to version 21 ([ec3c297](https://github.com/xicoarm/suisse-notes-desktop/commit/ec3c297c0379213cb2468f2be5c729c9e51e39c3))

## [3.4.9](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.8...v3.4.9) (2026-01-26)


### Bug Fixes

* handle auto-update signature verification for unsigned builds ([14e0980](https://github.com/xicoarm/suisse-notes-desktop/commit/14e0980431fe5d50e53907be2ed979f967d9736e))

## [3.4.8](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.7...v3.4.8) (2026-01-26)


### Bug Fixes

* **android:** set JVM target to 17 for Java/Kotlin compatibility ([9f07591](https://github.com/xicoarm/suisse-notes-desktop/commit/9f07591ac57a4f60eb38ce1ff27901ecda06b6ed))

## [3.4.7](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.6...v3.4.7) (2026-01-26)


### Bug Fixes

* **ci:** iOS uses SPM not CocoaPods, fix xcodebuild command ([fa105ac](https://github.com/xicoarm/suisse-notes-desktop/commit/fa105acd27cafde7b133906eaaa9e453f7f30ec4))

## [3.4.6](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.5...v3.4.6) (2026-01-26)


### Bug Fixes

* **ci:** use npx quasar instead of global quasar command ([afc3b1e](https://github.com/xicoarm/suisse-notes-desktop/commit/afc3b1ed6a5e5b9dd70bbb521517f1a90790246b))

## [3.4.5](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.4...v3.4.5) (2026-01-26)


### Bug Fixes

* **ci:** fix Android and iOS mobile builds ([8235068](https://github.com/xicoarm/suisse-notes-desktop/commit/8235068900b998acc8d2c8333db023e96d69d8e7))

## [3.4.4](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.3...v3.4.4) (2026-01-26)


### Bug Fixes

* **ci:** update FFmpeg download URL for macOS build ([146397c](https://github.com/xicoarm/suisse-notes-desktop/commit/146397ce7776fc0421983b4e402d06b49303e321))

## [3.4.3](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.2...v3.4.3) (2026-01-26)


### Bug Fixes

* **ci:** upgrade Node.js to v22 for Capacitor CLI compatibility ([21f8e42](https://github.com/xicoarm/suisse-notes-desktop/commit/21f8e4287ee2128e079cb010c4de90a3df2eb44d))

# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [3.4.2](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.1...v3.4.2) (2026-01-26)


### Bug Fixes

* add window icon for Windows taskbar ([4e2de63](https://github.com/xicoarm/suisse-notes-desktop/commit/4e2de6377e5686bb865429e85ac70851116c8d3b))

### [3.4.1](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.4.0...v3.4.1) (2026-01-26)


### Bug Fixes

* security hardening and auto-update for public repo ([44db673](https://github.com/xicoarm/suisse-notes-desktop/commit/44db67329247e9a2ca3462ccfb991d632b709060))

# [3.4.0](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.12...v3.4.0) (2026-01-26)


### Features

* add Android/Capacitor support and Play Store release ([6d3db80](https://github.com/xicoarm/suisse-notes-desktop/commit/6d3db803d8cfad99edaf37da72e61129f976c90d))
* redesign UI with separate Record/Upload pages and modern header ([a8396a3](https://github.com/xicoarm/suisse-notes-desktop/commit/a8396a3590b683c06ff1e8f3507f798d76b3a5c0))

# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [3.3.12](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.11...v3.3.12) (2026-01-06)


### Features

* add copyright year to footer ([71e13c0](https://github.com/xicoarm/suisse-notes-desktop/commit/71e13c014acea4519333dafcc8a5c0c15dea376c))

### [3.3.11](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.10...v3.3.11) (2026-01-06)

### [3.3.10](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.9...v3.3.10) (2026-01-06)

### [3.3.9](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.8...v3.3.9) (2026-01-06)


### Bug Fixes

* Add actual FFmpeg binaries (was placeholder files) ([283bc30](https://github.com/xicoarm/suisse-notes-desktop/commit/283bc30d9e565812229781f98aad97d26b991768))

### [3.3.8](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.7...v3.3.8) (2026-01-06)

### [3.3.7](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.6...v3.3.7) (2026-01-06)


### Bug Fixes

* Improve FFmpeg error handling and auto-update config ([ec5f463](https://github.com/xicoarm/suisse-notes-desktop/commit/ec5f463973e68af11b9bf98985de65588c5c542f))

### [3.3.6](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.5...v3.3.6) (2026-01-06)


### Bug Fixes

* Update app name to Suisse Notes ([b954b94](https://github.com/xicoarm/suisse-notes-desktop/commit/b954b94872b2958258624aa1af607feb02bfcf66))

### [3.3.5](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.3.4...v3.3.5) (2026-01-06)


### Bug Fixes

* Prevent double file dialog and add FFmpeg timeout handling ([5d1afcc](https://github.com/xicoarm/suisse-notes-desktop/commit/5d1afccd3dd9afdf28cb00ea7ee7232a94fcbf71))
