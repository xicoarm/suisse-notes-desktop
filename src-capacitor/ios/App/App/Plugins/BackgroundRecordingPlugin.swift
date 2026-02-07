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
    private var lastChunkTimestamp: Date = Date()

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

    private func stopCurrentRecording(call: CAPPluginCall) {
        chunkTimer?.invalidate()
        chunkTimer = nil
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil

        audioRecorder?.stop()
        audioRecorder = nil

        isRecording = false

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

    @objc private func handleInterruption(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            // Interruption began (e.g., phone call)
            audioRecorder?.pause()
            chunkTimer?.invalidate()
            healthCheckTimer?.invalidate()
            notifyListeners("interrupted", data: ["reason": "call"])

        case .ended:
            // Interruption ended
            guard let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt else { return }
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)

            if options.contains(.shouldResume) {
                audioRecorder?.record()
                lastChunkTimestamp = Date()
                startChunkTimer()
                startHealthCheckTimer()
                notifyListeners("resumed", data: [:])
            }

        @unknown default:
            break
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
