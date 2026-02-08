import Foundation
import AVFoundation
import Capacitor

/**
 * BackgroundRecordingPlugin
 * Native iOS plugin for background audio recording with AVAudioRecorder
 * Supports:
 * - Background recording via audio session
 * - 5-second chunk intervals for crash recovery
 * - Phone call interruption handling
 * - Health check monitoring to detect dead recordings
 */
@objc(BackgroundRecordingPlugin)
public class BackgroundRecordingPlugin: CAPPlugin {

    // MARK: - Properties

    private var audioRecorder: AVAudioRecorder?
    private var audioSession: AVAudioSession?
    private var chunkTimer: Timer?
    private var healthCheckTimer: Timer?
    private var recordingSession: RecordingSession?
    private var isRecording = false
    private var isInterrupted = false // P0 Data Loss Fix: Track interruption state (V4)
    private var isRecovering = false // FIX 5: Prevent health check during recovery window
    private var lastChunkTimestamp: Date = Date()
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid // FIX 2: Background task protection

    // Recording settings
    private let sampleRate: Double = 48000
    private let channels: Int = 1
    private let bitRate: Int = 128000
    private let chunkIntervalSeconds: TimeInterval = 5.0
    private let healthCheckIntervalSeconds: TimeInterval = 2.0

    // MARK: - Recording Session Model

    struct RecordingSession {
        let id: String
        let startTime: Date
        var chunkIndex: Int
        var chunksDirectory: URL
        var currentChunkURL: URL?
    }

    // MARK: - Plugin Methods

    @objc func startRecording(_ call: CAPPluginCall) {
        guard let recordId = call.getString("recordId") else {
            call.reject("Missing recordId parameter")
            return
        }

        if isRecording {
            call.reject("Already recording")
            return
        }

        DispatchQueue.main.async { [weak self] in
            self?.setupAndStartRecording(recordId: recordId, call: call)
        }
    }

    @objc func stopRecording(_ call: CAPPluginCall) {
        guard isRecording else {
            call.reject("Not currently recording")
            return
        }

        DispatchQueue.main.async { [weak self] in
            self?.stopCurrentRecording(call: call)
        }
    }

    @objc func pauseRecording(_ call: CAPPluginCall) {
        guard isRecording, let recorder = audioRecorder else {
            call.reject("Not currently recording")
            return
        }

        recorder.pause()
        chunkTimer?.invalidate()
        healthCheckTimer?.invalidate()

        call.resolve(["success": true])
    }

    @objc func resumeRecording(_ call: CAPPluginCall) {
        guard let recorder = audioRecorder else {
            call.reject("No active recording to resume")
            return
        }

        recorder.record()
        lastChunkTimestamp = Date()
        startChunkTimer()
        startHealthCheckTimer()

        call.resolve(["success": true])
    }

    @objc func combineChunks(_ call: CAPPluginCall) {
        guard let recordId = call.getString("recordId") else {
            call.reject("Missing recordId parameter")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.performCombineChunks(recordId: recordId, call: call)
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let isRecorderActive = audioRecorder?.isRecording ?? false
        let secondsSinceLastChunk = Date().timeIntervalSince(lastChunkTimestamp)
        let lastChunkMs = lastChunkTimestamp.timeIntervalSince1970 * 1000

        call.resolve([
            "isRecording": isRecording,
            "isRecorderActive": isRecorderActive,
            "chunkIndex": recordingSession?.chunkIndex ?? 0,
            "recordId": recordingSession?.id ?? "",
            "secondsSinceLastChunk": secondsSinceLastChunk,
            "lastChunkTimestampMs": lastChunkMs
        ])
    }

    // MARK: - Private Methods

    private func setupAndStartRecording(recordId: String, call: CAPPluginCall) {
        do {
            // FIX 2: Request background task to prevent iOS from killing app during recording
            beginBackgroundTaskProtection()

            // Configure audio session for background recording
            audioSession = AVAudioSession.sharedInstance()

            try audioSession?.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers]
            )
            try audioSession?.setActive(true)

            // Add interruption observer for phone calls
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleInterruption),
                name: AVAudioSession.interruptionNotification,
                object: audioSession
            )

            // Add route change observer to detect audio device changes
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleRouteChange),
                name: AVAudioSession.routeChangeNotification,
                object: audioSession
            )

            // Create chunks directory
            let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let chunksDirectory = documentsPath
                .appendingPathComponent("recordings")
                .appendingPathComponent(recordId)
                .appendingPathComponent("chunks")

            try FileManager.default.createDirectory(at: chunksDirectory, withIntermediateDirectories: true)

            // Initialize recording session
            recordingSession = RecordingSession(
                id: recordId,
                startTime: Date(),
                chunkIndex: 0,
                chunksDirectory: chunksDirectory
            )

            // Start first chunk
            try startNewChunk()

            isRecording = true
            startChunkTimer()
            startHealthCheckTimer()

            call.resolve([
                "success": true,
                "recordId": recordId
            ])

        } catch {
            call.reject("Failed to start recording: \(error.localizedDescription)")
        }
    }

    private func startNewChunk() throws {
        guard var session = recordingSession else {
            throw NSError(domain: "BackgroundRecording", code: 1, userInfo: [NSLocalizedDescriptionKey: "No active session"])
        }

        // Stop current recorder if any
        if let currentRecorder = audioRecorder, currentRecorder.isRecording {
            currentRecorder.stop()
        }

        // Create new chunk file
        let chunkFileName = String(format: "chunk_%06d.m4a", session.chunkIndex)
        let chunkURL = session.chunksDirectory.appendingPathComponent(chunkFileName)

        // Recording settings for M4A (AAC)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: bitRate,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]

        // Create and configure recorder
        audioRecorder = try AVAudioRecorder(url: chunkURL, settings: settings)
        audioRecorder?.delegate = self
        audioRecorder?.isMeteringEnabled = true
        audioRecorder?.record()

        // Update chunk timestamp
        lastChunkTimestamp = Date()

        // Update session
        session.currentChunkURL = chunkURL
        session.chunkIndex += 1
        recordingSession = session

        // Notify JS about new chunk
        notifyListeners("chunkStarted", data: [
            "chunkIndex": session.chunkIndex - 1,
            "chunkPath": chunkURL.path
        ])
    }

    private func startChunkTimer() {
        chunkTimer?.invalidate()
        chunkTimer = Timer.scheduledTimer(withTimeInterval: chunkIntervalSeconds, repeats: true) { [weak self] _ in
            self?.rotateChunk()
        }
    }

    private func startHealthCheckTimer() {
        healthCheckTimer?.invalidate()
        healthCheckTimer = Timer.scheduledTimer(withTimeInterval: healthCheckIntervalSeconds, repeats: true) { [weak self] _ in
            self?.performHealthCheck()
        }
    }

    private func performHealthCheck() {
        guard isRecording else { return }

        // P0 Data Loss Fix: Don't declare death during interruption (V4)
        guard !isInterrupted else { return }

        // FIX 5: Don't declare death during recovery window (0.5s after interruption ends)
        guard !isRecovering else { return }

        let recorderIsActive = audioRecorder?.isRecording ?? false

        if !recorderIsActive {
            // Native recorder has stopped but our flag says recording
            handleRecordingDeath(reason: "native_recorder_stopped")
        }
    }

    private func handleRecordingDeath(reason: String) {
        guard isRecording else { return } // Already handled

        // Stop all timers
        chunkTimer?.invalidate()
        chunkTimer = nil
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil

        isRecording = false
        endBackgroundTaskProtection() // FIX 2

        let chunkCount = recordingSession?.chunkIndex ?? 0
        let lastChunkMs = lastChunkTimestamp.timeIntervalSince1970 * 1000

        // Fire event to JS
        notifyListeners("recordingDead", data: [
            "reason": reason,
            "chunkCount": chunkCount,
            "lastChunkTimestampMs": lastChunkMs
        ])
    }

    private func rotateChunk() {
        guard isRecording else { return }

        do {
            try startNewChunk()
        } catch {
            print("Failed to rotate chunk: \(error)")
            notifyListeners("error", data: ["message": "Failed to save chunk: \(error.localizedDescription)"])
        }
    }

    private func performCombineChunks(recordId: String, call: CAPPluginCall) {
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let chunksDirectory = documentsPath
            .appendingPathComponent("recordings")
            .appendingPathComponent(recordId)
            .appendingPathComponent("chunks")

        // List and sort chunk files — accept both .m4a and .webm
        guard let chunkFiles = try? FileManager.default.contentsOfDirectory(at: chunksDirectory, includingPropertiesForKeys: nil)
            .filter({ $0.lastPathComponent.hasPrefix("chunk_") && ($0.pathExtension == "m4a" || $0.pathExtension == "webm") })
            .sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) else {
            call.reject("Could not list chunk files")
            return
        }

        if chunkFiles.isEmpty {
            call.reject("No audio chunks found")
            return
        }

        // Detect format from the chunks found
        let isWebM = chunkFiles.first?.pathExtension == "webm"

        if isWebM {
            // WebM chunks: simple binary concatenation
            // WebM chunks from the same MediaRecorder session can be concatenated because
            // the first chunk contains the WebM/EBML header and subsequent chunks contain
            // Cluster elements that append naturally.
            let outputURL = documentsPath
                .appendingPathComponent("recordings")
                .appendingPathComponent(recordId)
                .appendingPathComponent("combined.webm")

            // Remove existing output file if present
            try? FileManager.default.removeItem(at: outputURL)

            do {
                FileManager.default.createFile(atPath: outputURL.path, contents: nil)
                let outputHandle = try FileHandle(forWritingTo: outputURL)
                defer { outputHandle.closeFile() }

                var loadedChunkCount = 0
                for chunkURL in chunkFiles {
                    let chunkData = try Data(contentsOf: chunkURL)
                    outputHandle.write(chunkData)
                    loadedChunkCount += 1
                }

                if loadedChunkCount == 0 {
                    call.reject("Could not read any audio chunks")
                    return
                }

                let fileSize = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int64) ?? 0
                let relativePath = "recordings/\(recordId)/combined.webm"

                call.resolve([
                    "success": true,
                    "outputPath": relativePath,
                    "fileSize": fileSize,
                    "chunkCount": loadedChunkCount
                ])
            } catch {
                NSLog("BackgroundRecording: WebM combine failed: \(error)")
                call.reject("Failed to combine WebM chunks: \(error.localizedDescription)")
            }
        } else {
            // M4A chunks: use AVMutableComposition for proper AAC merging
            let outputURL = documentsPath
                .appendingPathComponent("recordings")
                .appendingPathComponent(recordId)
                .appendingPathComponent("combined.m4a")

            let composition = AVMutableComposition()
            guard let compositionTrack = composition.addMutableTrack(
                withMediaType: .audio,
                preferredTrackID: kCMPersistentTrackID_Invalid
            ) else {
                call.reject("Failed to create composition track")
                return
            }

            var insertTime = CMTime.zero
            var loadedChunkCount = 0

            for chunkURL in chunkFiles {
                let asset = AVURLAsset(url: chunkURL)
                // Load tracks synchronously for background thread
                let tracks = asset.tracks(withMediaType: .audio)
                guard let assetTrack = tracks.first else {
                    NSLog("BackgroundRecording: Skipping corrupt chunk: \(chunkURL.lastPathComponent)")
                    continue
                }

                let duration = asset.duration
                do {
                    try compositionTrack.insertTimeRange(
                        CMTimeRange(start: .zero, duration: duration),
                        of: assetTrack,
                        at: insertTime
                    )
                    insertTime = CMTimeAdd(insertTime, duration)
                    loadedChunkCount += 1
                } catch {
                    NSLog("BackgroundRecording: Error inserting chunk \(chunkURL.lastPathComponent): \(error)")
                    continue
                }
            }

            if loadedChunkCount == 0 {
                call.reject("Could not read any audio chunks")
                return
            }

            // Remove existing output file if present
            try? FileManager.default.removeItem(at: outputURL)

            // Export the composition as M4A
            guard let exportSession = AVAssetExportSession(
                asset: composition,
                presetName: AVAssetExportPresetAppleM4A
            ) else {
                call.reject("Failed to create export session")
                return
            }

            exportSession.outputURL = outputURL
            exportSession.outputFileType = .m4a

            let semaphore = DispatchSemaphore(value: 0)
            exportSession.exportAsynchronously {
                semaphore.signal()
            }
            semaphore.wait()

            switch exportSession.status {
            case .completed:
                // Get file size
                let fileSize = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int64) ?? 0

                // Return relative path for Capacitor compatibility
                let relativePath = "recordings/\(recordId)/combined.m4a"

                call.resolve([
                    "success": true,
                    "outputPath": relativePath,
                    "fileSize": fileSize,
                    "chunkCount": loadedChunkCount
                ])

            case .failed:
                let errorMsg = exportSession.error?.localizedDescription ?? "Export failed"
                NSLog("BackgroundRecording: Export failed: \(errorMsg)")
                call.reject("Failed to combine chunks: \(errorMsg)")

            case .cancelled:
                call.reject("Export was cancelled")

            default:
                call.reject("Unexpected export status: \(exportSession.status.rawValue)")
            }
        }
    }

    private func stopCurrentRecording(call: CAPPluginCall) {
        chunkTimer?.invalidate()
        chunkTimer = nil
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil

        audioRecorder?.stop()
        audioRecorder = nil

        isRecording = false
        endBackgroundTaskProtection() // FIX 2

        // Deactivate audio session
        try? audioSession?.setActive(false)

        // Remove observers
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: audioSession)
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: audioSession)

        guard let session = recordingSession else {
            call.reject("No recording session found")
            return
        }

        call.resolve([
            "success": true,
            "recordId": session.id,
            "chunkCount": session.chunkIndex,
            "chunksDirectory": session.chunksDirectory.path
        ])

        recordingSession = nil
    }

    // MARK: - Background Task Protection (FIX 2)

    private func beginBackgroundTaskProtection() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "SuisseNotesRecording") { [weak self] in
            // Expiration handler — iOS is about to kill our background time
            guard let self = self else { return }
            NSLog("BackgroundRecording: Background task expiring, saving checkpoint")
            // Save state checkpoint
            if let session = self.recordingSession {
                UserDefaults.standard.set(session.id, forKey: "bgRecording_recordId")
                UserDefaults.standard.set(session.chunkIndex, forKey: "bgRecording_chunkIndex")
            }
            // Stop recorder gracefully to preserve last chunk
            self.audioRecorder?.stop()
            self.endBackgroundTaskProtection()
        }
    }

    private func endBackgroundTaskProtection() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    @objc private func handleInterruption(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            // Interruption began (e.g., phone call)
            isInterrupted = true
            audioRecorder?.pause()
            chunkTimer?.invalidate()
            healthCheckTimer?.invalidate()
            notifyListeners("interrupted", data: ["reason": "call"])

        case .ended:
            // P0 Data Loss Fix: Always attempt resume after interruption (V4)
            // Previously gated on .shouldResume flag, which is unreliable
            // FIX 5: Keep isInterrupted=true and set isRecovering=true during the 0.5s recovery window
            // so health check doesn't falsely declare death
            isRecovering = true

            // Add 0.5s delay for audio system to settle
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self = self, self.isRecording else {
                    self?.isInterrupted = false
                    self?.isRecovering = false
                    return
                }

                // Try to reactivate audio session
                do {
                    try self.audioSession?.setActive(true)
                } catch {
                    NSLog("BackgroundRecording: Failed to reactivate audio session: \(error)")
                }

                if let recorder = self.audioRecorder {
                    // Existing recorder - try to resume
                    let resumed = recorder.record()
                    if resumed {
                        self.lastChunkTimestamp = Date()
                        self.startChunkTimer()
                        self.startHealthCheckTimer()
                        self.isInterrupted = false
                        self.isRecovering = false
                        self.notifyListeners("resumed", data: [:])
                        self.schedulePostResumeVerification()
                    } else {
                        // Recorder failed to resume - try starting a new chunk
                        NSLog("BackgroundRecording: recorder.record() returned false, trying new chunk")
                        do {
                            try self.startNewChunk()
                            self.startChunkTimer()
                            self.startHealthCheckTimer()
                            self.isInterrupted = false
                            self.isRecovering = false
                            self.notifyListeners("resumed", data: ["recoveredWithNewChunk": true])
                            self.schedulePostResumeVerification()
                        } catch {
                            NSLog("BackgroundRecording: Recovery failed: \(error)")
                            self.isInterrupted = false
                            self.isRecovering = false
                            self.handleRecordingDeath(reason: "interruption_resume_failed")
                        }
                    }
                } else {
                    // Recorder was released by the system - try to start a new chunk
                    NSLog("BackgroundRecording: recorder is nil after interruption, trying new chunk")
                    do {
                        try self.startNewChunk()
                        self.startChunkTimer()
                        self.startHealthCheckTimer()
                        self.isInterrupted = false
                        self.isRecovering = false
                        self.notifyListeners("resumed", data: ["recoveredWithNewChunk": true])
                        self.schedulePostResumeVerification()
                    } catch {
                        NSLog("BackgroundRecording: Recovery from nil recorder failed: \(error)")
                        self.isInterrupted = false
                        self.isRecovering = false
                        self.handleRecordingDeath(reason: "interruption_resume_failed")
                    }
                }
            }

        @unknown default:
            break
        }
    }

    // Fix 5: Post-resume verification — ensure recording is actually producing audio
    private func schedulePostResumeVerification() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self = self, self.isRecording, !self.isInterrupted else { return }
            if let chunkURL = self.recordingSession?.currentChunkURL {
                let attrs = try? FileManager.default.attributesOfItem(atPath: chunkURL.path)
                let fileSize = (attrs?[.size] as? Int64) ?? 0
                if fileSize == 0 {
                    NSLog("BackgroundRecording: Post-resume verification failed (0 bytes), rotating chunk")
                    do {
                        try self.startNewChunk()
                    } catch {
                        NSLog("BackgroundRecording: Post-resume chunk rotation failed: \(error)")
                        self.handleRecordingDeath(reason: "resume_verification_failed")
                    }
                }
            }
        }
    }

    @objc private func handleRouteChange(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        switch reason {
        case .oldDeviceUnavailable, .categoryChange:
            // Audio device disconnected or category changed - check if recorder is still alive
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self = self, self.isRecording else { return }
                let recorderIsActive = self.audioRecorder?.isRecording ?? false
                if !recorderIsActive {
                    self.handleRecordingDeath(reason: "route_change")
                }
            }
        default:
            break
        }
    }
}

// MARK: - AVAudioRecorderDelegate

extension BackgroundRecordingPlugin: AVAudioRecorderDelegate {
    public func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        if !flag && isRecording {
            // Recorder finished unsuccessfully while we think we're recording - this is a death
            handleRecordingDeath(reason: "recorder_finished_unsuccessfully")
        }
    }

    public func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        if let error = error {
            notifyListeners("error", data: ["message": "Encoding error: \(error.localizedDescription)"])
            if isRecording {
                handleRecordingDeath(reason: "encoding_error")
            }
        }
    }
}
