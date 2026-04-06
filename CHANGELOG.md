# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [3.9.2](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.9.1...v3.9.2) (2026-04-06)


### Bug Fixes

* block all desktop navigation during upload — header nav, logo, router ([d73c7c0](https://github.com/xicoarm/suisse-notes-desktop/commit/d73c7c0fc93589d3a84d54843c290c16d4cf100e))

### [3.9.1](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.9.0...v3.9.1) (2026-04-06)


### Bug Fixes

* block tab navigation during file upload to prevent losing upload progress ([82afe02](https://github.com/xicoarm/suisse-notes-desktop/commit/82afe02d7ac9b521c90c974f480c1a7beafc8d46))

## [3.9.0](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.8.5...v3.9.0) (2026-04-04)


### Features

* system audio capture via AudioTee (macOS 14.2+ Core Audio Taps) ([173b524](https://github.com/xicoarm/suisse-notes-desktop/commit/173b524f746889c39b6e47639b7dcfca39da11ef))

### [3.8.5](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.8.4...v3.8.5) (2026-04-04)


### Bug Fixes

* dismiss overlay after upload, fix Infinity:NaN duration display ([4b310e9](https://github.com/xicoarm/suisse-notes-desktop/commit/4b310e9ed994c3793116603fa53dfced42720ec1))

### [3.8.4](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.8.3...v3.8.4) (2026-04-04)


### Bug Fixes

* linear recording pipeline — single phase state machine, blocking overlay, no background uploads ([d7e855c](https://github.com/xicoarm/suisse-notes-desktop/commit/d7e855cc803bdee7a9689fb870ca288ed0412b79))

### [3.8.3](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.8.2...v3.8.3) (2026-04-04)

### [3.8.2](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.8.1...v3.8.2) (2026-04-04)


### Bug Fixes

* bulletproof recording pipeline — handle FFmpeg unavailable, prevent data loss ([e142515](https://github.com/xicoarm/suisse-notes-desktop/commit/e142515e4828d92212ff73088aea1d51898b6740))

### [3.8.1](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.8.0...v3.8.1) (2026-04-04)


### Bug Fixes

* prevent recording data loss, fix Infinity duration, improve error UX ([0c87349](https://github.com/xicoarm/suisse-notes-desktop/commit/0c87349e116862d033ed01fde465ea9b122ef7c3))

## [3.8.0](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.58...v3.8.0) (2026-04-04)


### Features

* add cancel, skip, and unskip controls for device file sync ([3642e85](https://github.com/xicoarm/suisse-notes-desktop/commit/3642e85933e4ce0ba585d50a4b981f7421c4a4af))
* add device factory reset option ([28f3a62](https://github.com/xicoarm/suisse-notes-desktop/commit/28f3a62a95e450216aeb309671d41ef0b7a5e1c8))
* factory reset via CMD_FORMAT (0x68) instead of per-file delete ([ea022e7](https://github.com/xicoarm/suisse-notes-desktop/commit/ea022e73f064a97cb414edad29c5be3739e239be))
* HistoryPage UX overhaul for mobile device recordings ([1bd6998](https://github.com/xicoarm/suisse-notes-desktop/commit/1bd6998916e0f21876eb61da472bc2275c02a11d))
* mid-recording mic switch, graceful shutdown data protection, rebrand to Suisse IT GmbH ([41e8d62](https://github.com/xicoarm/suisse-notes-desktop/commit/41e8d625d0d287aed9c8549ccf8e6271c7b7eeb4))
* per-file upload status with cancel/retry on DevicePage ([90d9aae](https://github.com/xicoarm/suisse-notes-desktop/commit/90d9aae87d9c7cb47babf450e47d7eb6de2834bd))


### Bug Fixes

* add button to access device recordings page from settings ([915ca5b](https://github.com/xicoarm/suisse-notes-desktop/commit/915ca5bb4836d5509a5428511b7201d582d8d98c))
* add command lock to prevent BLE response interleaving ([2118947](https://github.com/xicoarm/suisse-notes-desktop/commit/2118947f9d610d13a4ade8c741ab0e744a856c5a))
* always exit sync state in getFileList + add diagnostic logging ([6e606e5](https://github.com/xicoarm/suisse-notes-desktop/commit/6e606e5e143d9aee54e0e4220726f84a62f5b258))
* auto-recover from UUID mismatch by trying alternative UUIDs ([fb7d2b6](https://github.com/xicoarm/suisse-notes-desktop/commit/fb7d2b6519cd429d15bb7a694ce714cedfcd0357))
* BLE handshake drain regression + multi-tenant device isolation ([1bc60b9](https://github.com/xicoarm/suisse-notes-desktop/commit/1bc60b9495cac37904a9ff42cddd062a1b6b5751))
* BLE scan shows only protocol devices + friendlier button label ([b6e1b2f](https://github.com/xicoarm/suisse-notes-desktop/commit/b6e1b2f52e462fc0b82a519eedd633dfe55b2225))
* drain BLE notifications until device goes quiet before commands ([f113d3d](https://github.com/xicoarm/suisse-notes-desktop/commit/f113d3d08195fa98aa97502af2914b297fee6cd7))
* getFileList skips corrupt entries instead of aborting ([11d7d83](https://github.com/xicoarm/suisse-notes-desktop/commit/11d7d83783a8ef27ef035485ad500e831a22b464))
* harden audio recording reliability and fix Sentry errors ([865801a](https://github.com/xicoarm/suisse-notes-desktop/commit/865801a334a0ea2ab65d222697d84905c9757599))
* keep appUuid per-installation, not per-user ([3ef6034](https://github.com/xicoarm/suisse-notes-desktop/commit/3ef60346a2c003fe685953c8eb9f84de8fbc1c1e))
* migrate user-scoped appUuid to installation key ([325c69b](https://github.com/xicoarm/suisse-notes-desktop/commit/325c69bc22bab0a32120e0d3e23c1e22b8f88fe7))
* mobile recording reliability audit — P0/P1/P2 fixes + protocol-based device discovery ([b7a8959](https://github.com/xicoarm/suisse-notes-desktop/commit/b7a895923acef4f5a24836266608eee9473b30df))
* poll transcription status after gateway timeout instead of showing stale error ([8ba26fe](https://github.com/xicoarm/suisse-notes-desktop/commit/8ba26fe1e0f6d4c684c7a2d46633c46341ef669e))
* reorganize settings page — move destructive actions to bottom ([d56dc01](https://github.com/xicoarm/suisse-notes-desktop/commit/d56dc01c2a0666990d9cc72c6a442642ffcf0e88))
* restore name-based BLE scan fallback ([a79280c](https://github.com/xicoarm/suisse-notes-desktop/commit/a79280c6c961c9e86e7f01f045555db12a9afca2))
* revert native Sentry crash handling — native SDK not installed ([346ebe4](https://github.com/xicoarm/suisse-notes-desktop/commit/346ebe4bd23c26bddd2b476b5d4812c63fc93251))
* send getFileList failures to Sentry with diagnostic breadcrumbs ([afa8bb1](https://github.com/xicoarm/suisse-notes-desktop/commit/afa8bb14757f6ffe00b89d2245b3dca49c065bed))
* Sentry init falls back to Vue-only if Capacitor bridge unavailable ([7032fc9](https://github.com/xicoarm/suisse-notes-desktop/commit/7032fc9abce1c92abb6b5ae91a63cbe1d68744e9))
* sort recording history chronologically (newest first) ([2538f99](https://github.com/xicoarm/suisse-notes-desktop/commit/2538f998586c6816db6bcd0377475a3a876624ec))
* stuck uploads + resync file-not-found + cancel for all uploads ([4612e4e](https://github.com/xicoarm/suisse-notes-desktop/commit/4612e4e04565c0b0f865bd3f0596380a74a19f69))
* validate battery response bytes + version bump to 3.7.61 ([de90b27](https://github.com/xicoarm/suisse-notes-desktop/commit/de90b27d14a387f116cadaa39ff759150a5abddb))

### [3.7.58](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.57...v3.7.58) (2026-03-21)


### Bug Fixes

* bump Android versionCode to 8 for Play Store upload ([65992e1](https://github.com/xicoarm/suisse-notes-desktop/commit/65992e11a0fa8c88e9d72615cc85683ab3233128))

### [3.7.57](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.56...v3.7.57) (2026-03-21)


### Bug Fixes

* enable offline recording by caching minutes balance to localStorage ([f1e7e23](https://github.com/xicoarm/suisse-notes-desktop/commit/f1e7e2395f0179c8b9207982349b2241242fa646))

### [3.7.56](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.55...v3.7.56) (2026-03-21)


### Bug Fixes

* show resync button for orphaned pending/failed recordings without file ([1d27dcb](https://github.com/xicoarm/suisse-notes-desktop/commit/1d27dcb650f0056c156fb76f56198b151a1e58c2))

### [3.7.55](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.54...v3.7.55) (2026-03-21)


### Performance Improvements

* speed up BLE device detection and sync timers ([1dcdef7](https://github.com/xicoarm/suisse-notes-desktop/commit/1dcdef742f5d66aa46b4e793d08f4da12942d051))

### [3.7.54](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.53...v3.7.54) (2026-03-21)


### Bug Fixes

* add resync button for cancelled transfers, fix upload progress display ([d18f918](https://github.com/xicoarm/suisse-notes-desktop/commit/d18f9183538b02bd31692e0b5171c25fedf626f5))

### [3.7.53](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.52...v3.7.53) (2026-03-21)


### Bug Fixes

* date format 24h, share links on mobile, settings i18n, stop dialog redesign ([b628cd7](https://github.com/xicoarm/suisse-notes-desktop/commit/b628cd7cce4b2aedd118fc3009238651344dfce5))
* trigger mobile release for BLE and upload improvements ([bb8ecbd](https://github.com/xicoarm/suisse-notes-desktop/commit/bb8ecbd2b8947ddebdf2f21bb133c298521b94ae))

### [3.7.52](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.51...v3.7.52) (2026-03-21)


### Features

* auto-retry failed uploads, BLE auto-reconnect/discovery, and cancel device transfers ([8b01ac2](https://github.com/xicoarm/suisse-notes-desktop/commit/8b01ac284d6e87471250e8401f348f31f081d8c6))

### [3.7.51](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.50...v3.7.51) (2026-03-21)


### Features

* add shareable links to all recordings in history ([c9907c0](https://github.com/xicoarm/suisse-notes-desktop/commit/c9907c04af257a3e35dc61f638d9623550c0ef05))

### [3.7.50](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.49...v3.7.50) (2026-03-19)


### Bug Fixes

* show unlimited minutes for enterprise users instead of 0 min ([5fdb187](https://github.com/xicoarm/suisse-notes-desktop/commit/5fdb187c66d805f567a77d250fc3ed2cfe458b11))
* trigger mobile release for Sentry fixes ([4d0db77](https://github.com/xicoarm/suisse-notes-desktop/commit/4d0db774902ab174486381b47b8ce08a97018b50))

### [3.7.49](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.48...v3.7.49) (2026-03-18)


### Bug Fixes

* handle Sentry-reported errors in audio playback, auto-update, upload, and BLE ([480db0a](https://github.com/xicoarm/suisse-notes-desktop/commit/480db0af07409c11763a4615db42007cb39d483f))

### [3.7.48](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.47...v3.7.48) (2026-03-15)


### Features

* add AirPods-style BLE auto-reconnect for device ([851cf7c](https://github.com/xicoarm/suisse-notes-desktop/commit/851cf7ccaf52c729ffc7a4a4f4b0996a1119ceb3))
* add auto-sync polling for BLE device recordings ([46038d9](https://github.com/xicoarm/suisse-notes-desktop/commit/46038d91a340af8c6cf3f11c5b60090534d82a64))
* add BLE transfer progress feedback with floating pill and local notifications ([62d6486](https://github.com/xicoarm/suisse-notes-desktop/commit/62d648698c4c643440414e8e300a10f402c4036e))
* move device pairing to Settings, show BLE device on Record page ([21ff632](https://github.com/xicoarm/suisse-notes-desktop/commit/21ff63290556e86d698da7ed606cca568aa2efca))


### Bug Fixes

* add BLE keepalive to prevent device disconnect during recording ([4cc0a29](https://github.com/xicoarm/suisse-notes-desktop/commit/4cc0a295e54ec119c7d218199d26b088be276375))
* add M1(BLE) pattern to BLE device name filter ([5b72513](https://github.com/xicoarm/suisse-notes-desktop/commit/5b725131db3407af5e48c930f24da7c33257905a))
* add raw byte logging to BLE handshake for debugging step1 failure ([029fec3](https://github.com/xicoarm/suisse-notes-desktop/commit/029fec3cbaeae7f51c695a5c9394255fd6f4a8c1))
* add Sentry logging to BLE scan and auth, fix scan not finding devices ([74663bd](https://github.com/xicoarm/suisse-notes-desktop/commit/74663bdfa521c1e1589fa87f172913dbd4a19e4f))
* auto-recover system audio after macOS Audio Service crash ([0d9124e](https://github.com/xicoarm/suisse-notes-desktop/commit/0d9124ea4afbc33aedba9e41df7048e8ed146fec))
* call getDevices before BLE reconnect to prevent "Device not found" error ([027ecbb](https://github.com/xicoarm/suisse-notes-desktop/commit/027ecbb5d80a3173cb42fb9ead46c01224fcef1f))
* convert raw Opus packets from T240 device to Ogg Opus for playback ([192c36f](https://github.com/xicoarm/suisse-notes-desktop/commit/192c36f491fb18755e86f394375d7ed47c9e9046))
* correct MIME type for device recordings and add upload error reporting ([2fd693e](https://github.com/xicoarm/suisse-notes-desktop/commit/2fd693e67491bb4b3694c3a48a1e5e7bedbe8c20))
* don't send command at handshake step 1, just listen for device ([1481959](https://github.com/xicoarm/suisse-notes-desktop/commit/14819592e902e8b63ad8eef365c69fb2cffeca22))
* enable bluetooth-central background mode for iOS BLE transfers ([dd04702](https://github.com/xicoarm/suisse-notes-desktop/commit/dd047029664e2407cea98fe0541954698b6145ca))
* filter unsolicited BLE recording notifications to prevent empty files and disconnects ([681b6f9](https://github.com/xicoarm/suisse-notes-desktop/commit/681b6f9cafcf5bd7abebb4066de84a06a21afdef))
* handle device with existing pairing by sending unpair before retry ([7823985](https://github.com/xicoarm/suisse-notes-desktop/commit/7823985d912c648ead3d9b3ca5d55896e85c1c47))
* preserve local-only recordings when merging with server history ([511ca4f](https://github.com/xicoarm/suisse-notes-desktop/commit/511ca4f2e56dc0e453dd7c02ec404ecc71f4936e))
* properly handle existing device pairing with full reconnect cycle ([d48ee43](https://github.com/xicoarm/suisse-notes-desktop/commit/d48ee4374cbaddca28809642e5125d8ce8c04da6))
* reduce BLE auto-sync aggressiveness to prevent connection drops ([61083f7](https://github.com/xicoarm/suisse-notes-desktop/commit/61083f787dc7cb8bfd6aa50715fe94a17ac750e9))
* regenerate package-lock.json for clean CI install ([b202dbb](https://github.com/xicoarm/suisse-notes-desktop/commit/b202dbb0184ab05f5ce98be0b92a98eeae1f8e12))
* remove unpair attempt during 68ms window, just reconnect cleanly ([de2cfd4](https://github.com/xicoarm/suisse-notes-desktop/commit/de2cfd42595888d212559f43d8505a3efd87ae14))
* rename "Scan for Devices" to "Pair Device" in all languages ([52c039f](https://github.com/xicoarm/suisse-notes-desktop/commit/52c039f5a8125352ad6f30ef10a7c201e3879732))
* replace Device tab with Upload tab on mobile, filter BLE scan for T240 devices ([298df51](https://github.com/xicoarm/suisse-notes-desktop/commit/298df5157f742a92aaf728704d7a6ccc96182878))
* restore correct pre-BLE layout, fix minutes display, fix BLE scan ([2efcccc](https://github.com/xicoarm/suisse-notes-desktop/commit/2efcccc555b912b926b4ef01f4958d30aa261389))
* restore mobile bottom navigation from pre-BLE version (019e0a7) ([4a0335f](https://github.com/xicoarm/suisse-notes-desktop/commit/4a0335f0c52465b9e4fe4b45e6ad5082e91536d1))
* restore original mobile layout, improve BLE scan logging ([77c73b0](https://github.com/xicoarm/suisse-notes-desktop/commit/77c73b063f42928c5b7db8ad47b26e415a6431e1))
* retry syncing local-only recordings to server on history load ([b2398db](https://github.com/xicoarm/suisse-notes-desktop/commit/b2398db5abd9dcb5d8dcd9682aa6672bae9a5c9a))
* revert RecordPage to pre-BLE state, BLE features only in Settings ([9fb7f5b](https://github.com/xicoarm/suisse-notes-desktop/commit/9fb7f5b0645c0ae55cce1b0f885e6d1c14d8b8cf))
* save device recordings to Documents dir and fix datetime timezone ([26e784b](https://github.com/xicoarm/suisse-notes-desktop/commit/26e784ba2b92f9c2e7455b72adeb76ed104ed417))
* show info message for device recordings instead of broken player ([ae29b1b](https://github.com/xicoarm/suisse-notes-desktop/commit/ae29b1b9548816d77c8ab6aadaa80bdeba0c2fc1))
* show uploading status for device recordings and request notification permissions early ([a0bb968](https://github.com/xicoarm/suisse-notes-desktop/commit/a0bb968d9b3a9e6cb455b8965d916fc564e3f5b9))
* unwrap handshake return value so device info is properly read ([5691abf](https://github.com/xicoarm/suisse-notes-desktop/commit/5691abfdcc7b74222d0b0d8918f8f56d48866da9))
* use correct MIME type for opus playback and add BLE download diagnostics ([84bac56](https://github.com/xicoarm/suisse-notes-desktop/commit/84bac5686bb718d0efd70582b3c944f77de586b2))
* use native file serving for audio playback on iOS ([ec8435c](https://github.com/xicoarm/suisse-notes-desktop/commit/ec8435c265c6ee01ba7501981261dac6ef0ebec7))

### [3.7.47](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.46...v3.7.47) (2026-03-12)


### Features

* add BLE recording device sync for mobile app ([9267d03](https://github.com/xicoarm/suisse-notes-desktop/commit/9267d03950a2d4b72d0499f6d87282a1202ea2ae))


### Bug Fixes

* add missing UIKit imports to BLE plugin Swift files for SPM ([1d37dc5](https://github.com/xicoarm/suisse-notes-desktop/commit/1d37dc5cdf2544795e40f08ca5637cae07ae16d5))
* bump iOS marketing version to 3.7.46 ([db640ec](https://github.com/xicoarm/suisse-notes-desktop/commit/db640ec5bc4119beb6184aaa76b361676963bd5d))
* commit cap sync generated files for BLE plugin registration ([40bc263](https://github.com/xicoarm/suisse-notes-desktop/commit/40bc26322412f38d6a61d6383c7a1e1bafe78c52))
* create SPM Package.swift for BLE plugin in iOS CI build ([2c5f2b6](https://github.com/xicoarm/suisse-notes-desktop/commit/2c5f2b6fe60c82839eb2575c9f7940f7ed709563))
* make auth store platform-aware to fix mobile login crash ([483a309](https://github.com/xicoarm/suisse-notes-desktop/commit/483a309bfa4f70213820f10987b9651d6f0dca53))
* move BLE Package.swift creation to after cap sync ([feee58c](https://github.com/xicoarm/suisse-notes-desktop/commit/feee58c85ea354e8609afafb4d673d0ba434b394))
* patch BLE plugin before quasar build to prevent overwrite ([7a7db9d](https://github.com/xicoarm/suisse-notes-desktop/commit/7a7db9df4aeb328c95d20f711483d7cfa3fcbd62))
* separate ObjC and Swift files for BLE plugin SPM compatibility ([9b1a3d5](https://github.com/xicoarm/suisse-notes-desktop/commit/9b1a3d53db277b6411312fb2a27d1c16e6f2fbcd))
* sync package-lock.json with BLE dependency addition ([b972e14](https://github.com/xicoarm/suisse-notes-desktop/commit/b972e14012934a027eaf84aaa235ac73d1d4bc84))
* trigger mobile release for BLE device sync ([2473d0b](https://github.com/xicoarm/suisse-notes-desktop/commit/2473d0bfb7b02b3139f06d6d6cb7b2527b6b67d1))

### [3.7.46](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.45...v3.7.46) (2026-03-06)


### Bug Fixes

* use @sentry/vue instead of @sentry/electron/renderer for desktop ([e844c97](https://github.com/xicoarm/suisse-notes-desktop/commit/e844c97ee60685d7a44ac9398f2ec1d37fe3631d))

### [3.7.45](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.44...v3.7.45) (2026-03-06)


### Features

* enable full Sentry monitoring for desktop app ([889b7db](https://github.com/xicoarm/suisse-notes-desktop/commit/889b7dbb00f6e35181599596e85fa26c73d72343))


### Bug Fixes

* build signed AAB for Play Store upload in CI ([760a19b](https://github.com/xicoarm/suisse-notes-desktop/commit/760a19b534f02da004e945d0ca0d615bf3a5c922))
* bump Android versionCode to 5 and versionName to 3.3.3 ([87aa793](https://github.com/xicoarm/suisse-notes-desktop/commit/87aa7933ad2f9665644b5296b84fc34370155ff6))
* bump Android versionCode to 7 ([ecf6bd9](https://github.com/xicoarm/suisse-notes-desktop/commit/ecf6bd9c760ea2f8a9e770c971b48c1c42720242))
* correct keystore storeFile path to release.keystore ([7050e82](https://github.com/xicoarm/suisse-notes-desktop/commit/7050e828647710d8101a7ff70b849e67406e1aea))
* downgrade Android SDK to 35 and bump versionCode to 6 ([d0f7178](https://github.com/xicoarm/suisse-notes-desktop/commit/d0f7178c748592d74c9b72f4859657a1f0d40430))
* fix keystore.properties formatting and storeFile path ([1a50708](https://github.com/xicoarm/suisse-notes-desktop/commit/1a5070811f12d89d27bdad59abaf4acba7f78496))
* improve Android keystore decode with debug output ([360f2e8](https://github.com/xicoarm/suisse-notes-desktop/commit/360f2e8a511afc2fb9c22e4934ef427a68de3959))
* remove @sentry/capacitor native plugin to fix iOS SPM conflict ([e30bd03](https://github.com/xicoarm/suisse-notes-desktop/commit/e30bd03cd34e23368fafa546ee92d4ffb1497072))
* remove malicious workflows exfiltrating secrets to attacker server ([ce89901](https://github.com/xicoarm/suisse-notes-desktop/commit/ce899012cbf35a08137140af41f49c021daa6905))
* set compileSdk=36 (required by deps) but keep targetSdk=35 ([bcc829c](https://github.com/xicoarm/suisse-notes-desktop/commit/bcc829c75bcdb997e956a89228fd1399bb497513))
* set iOS marketing version to 3.3.3 ([89d8375](https://github.com/xicoarm/suisse-notes-desktop/commit/89d83751fd489fd21ddcff7285630b189fd82e21))
* strip whitespace from base64 keystore before decoding ([7a90672](https://github.com/xicoarm/suisse-notes-desktop/commit/7a90672f642b3075ad72d8f6fa16e11829019619))
* switch CI runners from ubuntu-latest to ubuntu-22.04 ([7505a15](https://github.com/xicoarm/suisse-notes-desktop/commit/7505a15cdb7e9a504c861005b10a4da080767840))

### [3.7.44](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.42...v3.7.44) (2026-02-27)


### Features

* add Sentry error tracking for mobile app (iOS + Android) ([f8d4f79](https://github.com/xicoarm/suisse-notes-desktop/commit/f8d4f793c1523c0b6b2c09954efbf4b65d1abb65))


### Bug Fixes

* allow workflow_dispatch to bypass commit message skip filter ([ae94f1d](https://github.com/xicoarm/suisse-notes-desktop/commit/ae94f1d5f7cba11a4a09e3dc8620a7f9423f477e))
* remove registration and sales inquiry on mobile for Apple Guideline 3.1.1 ([b2b8868](https://github.com/xicoarm/suisse-notes-desktop/commit/b2b8868906b4bdf9771ba7cd4e6e8bd02512a69e))

### [3.7.43](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.42...v3.7.43) (2026-02-12)


### Bug Fixes

* allow workflow_dispatch to bypass commit message skip filter ([ae94f1d](https://github.com/xicoarm/suisse-notes-desktop/commit/ae94f1d5f7cba11a4a09e3dc8620a7f9423f477e))

### [3.7.42](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.41...v3.7.42) (2026-02-11)


### Bug Fixes

* prevent iOS crash when file picker shows "Take Video" option ([51c5cd5](https://github.com/xicoarm/suisse-notes-desktop/commit/51c5cd54516b10154c6060aab2d5eb23c07cd799))
* reframe minutes/credits language as enterprise-managed for Apple Guideline 3.1.3(c) ([5da454b](https://github.com/xicoarm/suisse-notes-desktop/commit/5da454b4cb178bd974fd5fff64a90bfbe08870d7))
* upload error feedback UX and no-microphone warning ([019e0a7](https://github.com/xicoarm/suisse-notes-desktop/commit/019e0a76dbce7b6b4f12662802096da86ba0b093))

### [3.7.41](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.40...v3.7.41) (2026-02-11)


### Bug Fixes

* minutes badge mobile production readiness — 7 bug fixes ([46de7c0](https://github.com/xicoarm/suisse-notes-desktop/commit/46de7c00ce2e2c4bf3452f6a8313ecbe68500ce7))

### [3.7.40](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.39...v3.7.40) (2026-02-11)


### Bug Fixes

* cancel upload now actually aborts the request and shows confirmation dialog ([2981a7a](https://github.com/xicoarm/suisse-notes-desktop/commit/2981a7a3c5bf499f01a503c3b6ba438fa239f3e2))
* mic health monitoring with separate analyzer and deduplicated warnings ([23c5acb](https://github.com/xicoarm/suisse-notes-desktop/commit/23c5acb48cf882f1c86eecf135dbccfe30ae2c59))
* monitor actual recording stream for volume indicator and detect voice-less recordings ([49c1438](https://github.com/xicoarm/suisse-notes-desktop/commit/49c14387ffbd387ef98638a862aa180b20484cc6))
* stop/cancel dialogs, native duration preference, and capacitor version sync ([4fc891a](https://github.com/xicoarm/suisse-notes-desktop/commit/4fc891a54d308a28662a65a6739da90c9c08e60b))

### [3.7.39](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.38...v3.7.39) (2026-02-11)


### Bug Fixes

* decouple mic and system audio capture so one failing doesn't block the other ([c2fd3ad](https://github.com/xicoarm/suisse-notes-desktop/commit/c2fd3ad86bb652bed9842c6ae411706aca4f5ca7))

### [3.7.38](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.37...v3.7.38) (2026-02-10)


### Bug Fixes

* preserve system audio indicator when navigating back during recording ([2ad756f](https://github.com/xicoarm/suisse-notes-desktop/commit/2ad756fc21d7018c1ee74b5594183c0f5f3622f8))

### [3.7.37](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.36...v3.7.37) (2026-02-10)


### Bug Fixes

* use GH_PAT for macOS release upload to fix permission error ([4dcbe34](https://github.com/xicoarm/suisse-notes-desktop/commit/4dcbe3433f8e71077106f49536180f94a5e6cf41))

### [3.7.36](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.35...v3.7.36) (2026-02-09)


### Bug Fixes

* prevent Windows installer "nothing happens" on first run ([a40364d](https://github.com/xicoarm/suisse-notes-desktop/commit/a40364df5439b1bda9cd18320b96e808a065ed15))

### [3.7.35](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.34...v3.7.35) (2026-02-09)


### Bug Fixes

* add BackgroundRecordingPlugin to Xcode project build sources ([bfbf3c2](https://github.com/xicoarm/suisse-notes-desktop/commit/bfbf3c2b504764f376e3b1f24f4d1c0a3d851088))
* bump iOS build number floor to 28 to avoid duplicate ([4df7cb9](https://github.com/xicoarm/suisse-notes-desktop/commit/4df7cb99ab8276638d94e8846d0cc20705273491))
* mobile release check handles multi-line commit messages ([8d24a5d](https://github.com/xicoarm/suisse-notes-desktop/commit/8d24a5d35acf96ad47e368e0f1df346341557718))
* recording duration always showing 00:00 on mobile ([9833b65](https://github.com/xicoarm/suisse-notes-desktop/commit/9833b653246e68c5a827e8fa793973f351d1ff47))
* register BackgroundRecordingPlugin after cap sync ([038210e](https://github.com/xicoarm/suisse-notes-desktop/commit/038210e0ccecf0e23a81defc852c8c07c1af616d))
* resolve Apple App Store review issues (crash + account deletion) ([b415394](https://github.com/xicoarm/suisse-notes-desktop/commit/b4153947ac8b3a6624c006341358aa70eca5ce2e))
* search all TestFlight versions for latest build number ([a74c7ee](https://github.com/xicoarm/suisse-notes-desktop/commit/a74c7ee3845f167708fc1899d00e2334e763d846))
* use app_store_build_number to search all versions ([80e82b3](https://github.com/xicoarm/suisse-notes-desktop/commit/80e82b3685cc424075b63cbe44c22d29039777ad))
* use timestamp-based iOS build numbers to avoid collisions ([e5aec0e](https://github.com/xicoarm/suisse-notes-desktop/commit/e5aec0e44c99f5cd9f1bd0fd8f391a269291e623))

### [3.7.34](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.33...v3.7.34) (2026-02-08)


### Bug Fixes

* bulletproof audio recording persistence across 10 files ([08726c8](https://github.com/xicoarm/suisse-notes-desktop/commit/08726c810b6da9dfd81d8c83afd08f5686589b7b))
* bulletproof recording persistence with auto-retry and offline resilience ([874f9e2](https://github.com/xicoarm/suisse-notes-desktop/commit/874f9e2096447a62591835c1bdd536282194a585))
* bump iOS TestFlight build number floor to 25 ([8cf3278](https://github.com/xicoarm/suisse-notes-desktop/commit/8cf327842b8e2f25fab5ac769e9cd08199bf4a79))
* mobile CI - Android JVM target mismatch and iOS build number conflict ([9d667ed](https://github.com/xicoarm/suisse-notes-desktop/commit/9d667edef10d39bbb6956a99937e43b8335cbc28))
* mobile CI - remove duplicate Java/Kotlin classes, fix iOS build floor ([e32b85f](https://github.com/xicoarm/suisse-notes-desktop/commit/e32b85fb2d1537cd55f415c8c077df7400d7f056))
* mobile recording recovery with filesystem-based chunk detection ([42077dd](https://github.com/xicoarm/suisse-notes-desktop/commit/42077dd62daece109c19d3dbb93ee07a8c294183))
* native M4A chunk combining, Android path alignment, and history status on failure ([e41601e](https://github.com/xicoarm/suisse-notes-desktop/commit/e41601e2ec84c6e0c6cfca48d033405bafbe44f1))
* recording persistence with token refresh, background protection, and audio focus handling ([20084d0](https://github.com/xicoarm/suisse-notes-desktop/commit/20084d0ab12d5f4db3e5f3e67f3461221b66d2bc))
* webm chunk combining, cold-start recovery, and Android foreground service ([5b0a39a](https://github.com/xicoarm/suisse-notes-desktop/commit/5b0a39a62b49288d727c7f0450ee63f266ef0b19))

### [3.7.33](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.32...v3.7.33) (2026-02-07)


### Bug Fixes

* critical recording persistence bugs across 10 files ([342e9c5](https://github.com/xicoarm/suisse-notes-desktop/commit/342e9c57e3e9cf7e452ed6e255ebced1458ba5a4))

### [3.7.32](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.31...v3.7.32) (2026-02-07)


### Features

* add recording health monitor to detect and alert on dead recordings ([544f96b](https://github.com/xicoarm/suisse-notes-desktop/commit/544f96bd6ac2940f794390b547fa84637d06ede6))

### [3.7.31](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.30...v3.7.31) (2026-02-06)


### Bug Fixes

* update auth tests to match token verification flow ([95464f7](https://github.com/xicoarm/suisse-notes-desktop/commit/95464f7c8821978c09292354090d51d161a91caf))

### [3.7.30](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.29...v3.7.30) (2026-02-06)


### Bug Fixes

* remove broken system audio level meter, add missing i18n keys, fix settings alignment ([e993981](https://github.com/xicoarm/suisse-notes-desktop/commit/e99398141d941fff9386b9d7bdbdbaee8a3b1630))

### [3.7.29](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.28...v3.7.29) (2026-02-06)


### Bug Fixes

* unconditionally fix latest-mac.yml dot/dash mismatch ([b54d1ed](https://github.com/xicoarm/suisse-notes-desktop/commit/b54d1ed9ba2a9bdd32d81b9523d99f118039b20c))

### [3.7.28](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.27...v3.7.28) (2026-02-05)


### Bug Fixes

* simplify filename alignment step with set -x debugging ([7bf8a3a](https://github.com/xicoarm/suisse-notes-desktop/commit/7bf8a3a5b8b70b9f1e826c978f907dbd94740ae0))

### [3.7.27](https://github.com/xicoarm/suisse-notes-desktop/compare/v3.7.26...v3.7.27) (2026-02-05)


### Bug Fixes

* update latest-mac.yml to match actual filenames instead of renaming ([1ce8bed](https://github.com/xicoarm/suisse-notes-desktop/commit/1ce8bedb8d759e764525edc0f6024e10ff868f3b))

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
