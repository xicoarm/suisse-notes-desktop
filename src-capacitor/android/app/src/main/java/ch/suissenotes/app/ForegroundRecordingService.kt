package ch.suissenotes.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.Timer
import java.util.TimerTask
import android.os.Environment

/**
 * ForegroundRecordingService
 * Android foreground service for background audio recording
 * Uses MediaRecorder with periodic chunk saving for crash recovery
 */
class ForegroundRecordingService : Service() {

    companion object {
        private const val TAG = "ForegroundRecording"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "recording_channel"
        private const val CHANNEL_NAME = "Recording"

        // Actions
        const val ACTION_START = "ch.suissenotes.app.START_RECORDING"
        const val ACTION_STOP = "ch.suissenotes.app.STOP_RECORDING"
        const val ACTION_PAUSE = "ch.suissenotes.app.PAUSE_RECORDING"
        const val ACTION_RESUME = "ch.suissenotes.app.RESUME_RECORDING"
        const val ACTION_NOTIFICATION_ONLY = "ch.suissenotes.app.NOTIFICATION_ONLY"

        // Extras
        const val EXTRA_RECORD_ID = "record_id"

        // Recording settings
        private const val SAMPLE_RATE = 48000
        private const val BIT_RATE = 128000
        private const val CHUNK_INTERVAL_MS = 5000L

        // State
        var isRecording = false
            private set
        var currentRecordId: String? = null
            private set
        var chunkIndex: Int = 0
            private set
        var lastChunkTimestampMs: Long = 0L
            private set

        // Broadcast actions
        const val ACTION_RECORDING_DEAD = "ch.suissenotes.app.RECORDING_DEAD"
        const val ACTION_RECORDING_INTERRUPTED = "ch.suissenotes.app.RECORDING_INTERRUPTED"
        const val ACTION_RECORDING_RESUMED = "ch.suissenotes.app.RECORDING_RESUMED"
        const val EXTRA_REASON = "reason"
        const val EXTRA_CHUNK_COUNT = "chunkCount"
        const val EXTRA_LAST_CHUNK_TIMESTAMP = "lastChunkTimestampMs"
    }

    private var mediaRecorder: MediaRecorder? = null
    private var chunkTimer: Timer? = null
    private var chunksDirectory: File? = null
    private var currentChunkFile: File? = null
    private val handler = Handler(Looper.getMainLooper())

    // FIX 3: Audio focus handling
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var isPausedByFocusLoss = false

    // FIX 6: Wake lock
    private var wakeLock: PowerManager.WakeLock? = null

    // Callbacks for plugin communication
    private var onChunkSaved: ((Int, String) -> Unit)? = null
    private var onError: ((String) -> Unit)? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action

        if (action == ACTION_NOTIFICATION_ONLY) {
            // Just show notification and start foreground — no native recording
            // Used when WebView MediaRecorder handles audio but we need foreground service protection
            createNotificationChannel()
            startForeground(NOTIFICATION_ID, createNotification("Recording in progress..."))
            return START_STICKY
        }

        when (action) {
            ACTION_START -> {
                val recordId = intent?.getStringExtra(EXTRA_RECORD_ID)
                if (recordId != null) {
                    startRecording(recordId)
                }
            }
            ACTION_STOP -> stopRecording()
            ACTION_PAUSE -> pauseRecording()
            ACTION_RESUME -> resumeRecording()
        }

        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (isRecording) {
            broadcastRecordingDeath("task_removed")
        }
        stopRecording()
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isRecording) {
            // Service being killed while recording - broadcast death
            broadcastRecordingDeath("service_destroyed")
        }
        stopRecording()
        // FIX 3 & 6: Ensure cleanup even if stopRecording skips
        abandonAudioFocus()
        releaseWakeLock()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Recording in progress"
                setShowBadge(false)
            }

            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Suisse Notes")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun startRecording(recordId: String) {
        if (isRecording) {
            Log.w(TAG, "Already recording")
            return
        }

        try {
            // P0 Data Loss Fix: Use the same directory that Capacitor's Directory.Documents resolves to
            // so JS code can find native-saved chunks. Fallback to filesDir if unavailable.
            val documentsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
                ?: filesDir
            chunksDirectory = File(documentsDir, "recordings/$recordId/chunks").apply {
                mkdirs()
            }

            // Migrate any existing recordings from external to internal storage
            migrateExternalChunks(recordId)

            currentRecordId = recordId
            chunkIndex = 0
            lastChunkTimestampMs = System.currentTimeMillis()

            // Start foreground service
            startForeground(NOTIFICATION_ID, createNotification("Recording in progress..."))

            // FIX 3: Request audio focus
            requestAudioFocus()

            // FIX 6: Acquire wake lock
            acquireWakeLock()

            // Start first chunk
            startNewChunk()

            isRecording = true

            // Start chunk rotation timer
            startChunkTimer()

            Log.i(TAG, "Recording started: $recordId")

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording", e)
            onError?.invoke("Failed to start recording: ${e.message}")
            releaseWakeLock()
            abandonAudioFocus()
            stopSelf()
        }
    }

    // Migrate existing recordings from old storage locations to the current Documents directory
    private fun migrateExternalChunks(recordId: String) {
        // Migrate from both old locations: getExternalFilesDir and filesDir
        val oldDirs = listOfNotNull(
            getExternalFilesDir(null),
            filesDir
        )
        for (oldDir in oldDirs) {
            try {
                val oldChunks = File(oldDir, "recordings/$recordId/chunks")
                // Skip if this IS the current chunks directory
                if (oldChunks.absolutePath == chunksDirectory?.absolutePath) continue
                if (oldChunks.exists() && oldChunks.isDirectory) {
                    val files = oldChunks.listFiles() ?: continue
                    for (file in files) {
                        val dest = File(chunksDirectory, file.name)
                        if (!dest.exists()) {
                            file.copyTo(dest)
                            file.delete()
                        }
                    }
                    // Clean up empty old directory
                    oldChunks.delete()
                    oldChunks.parentFile?.delete()
                    Log.i(TAG, "Migrated ${files.size} chunks from ${oldDir.name} to Documents")
                }
            } catch (e: Exception) {
                Log.w(TAG, "Migration from ${oldDir.name} failed (non-critical)", e)
            }
        }
    }

    private fun startNewChunk() {
        try {
            // Stop current recorder if any
            mediaRecorder?.apply {
                try {
                    stop()
                } catch (e: Exception) {
                    Log.w(TAG, "Error stopping previous recorder", e)
                }
                release()
            }

            // Create new chunk file
            val chunkFileName = String.format("chunk_%06d.m4a", chunkIndex)
            currentChunkFile = File(chunksDirectory, chunkFileName)

            // Initialize MediaRecorder
            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(SAMPLE_RATE)
                setAudioEncodingBitRate(BIT_RATE)
                setOutputFile(currentChunkFile?.absolutePath)

                // Set error listener for death detection
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "MediaRecorder error: what=$what, extra=$extra")
                    handleRecordingDeath("media_recorder_error")
                }

                prepare()
                start()
            }

            // Update chunk timestamp
            lastChunkTimestampMs = System.currentTimeMillis()

            Log.d(TAG, "Started chunk $chunkIndex: ${currentChunkFile?.name}")

            // Notify about chunk start
            onChunkSaved?.invoke(chunkIndex, currentChunkFile?.absolutePath ?: "")

            chunkIndex++

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start new chunk", e)
            onError?.invoke("Failed to save chunk: ${e.message}")
            // FIX 4: Escalate chunk creation failure to recording death
            handleRecordingDeath("chunk_creation_failed")
        }
    }

    private fun startChunkTimer() {
        chunkTimer?.cancel()
        chunkTimer = Timer().apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    if (isRecording) {
                        handler.post { rotateChunk() }
                    }
                }
            }, CHUNK_INTERVAL_MS, CHUNK_INTERVAL_MS)
        }
    }

    private fun rotateChunk() {
        if (!isRecording) return
        // FIX 4: Wrap in try-catch to prevent Timer thread death on exception
        try {
            startNewChunk()
        } catch (e: Exception) {
            Log.e(TAG, "Exception during chunk rotation", e)
            handleRecordingDeath("chunk_rotation_error")
        }
    }

    private fun handleRecordingDeath(reason: String) {
        if (!isRecording) return

        Log.w(TAG, "Recording death detected: $reason")

        // Stop timers
        chunkTimer?.cancel()
        chunkTimer = null

        // Stop recorder
        mediaRecorder?.apply {
            try {
                stop()
            } catch (e: Exception) {
                Log.w(TAG, "Error stopping recorder during death handling", e)
            }
            release()
        }
        mediaRecorder = null

        isRecording = false

        // Broadcast death event
        broadcastRecordingDeath(reason)

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun broadcastRecordingDeath(reason: String) {
        val intent = Intent(ACTION_RECORDING_DEAD).apply {
            putExtra(EXTRA_REASON, reason)
            putExtra(EXTRA_CHUNK_COUNT, chunkIndex)
            putExtra(EXTRA_LAST_CHUNK_TIMESTAMP, lastChunkTimestampMs)
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    private fun pauseRecording() {
        if (!isRecording) return

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                mediaRecorder?.pause()
            }
            chunkTimer?.cancel()

            // Update notification
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, createNotification("Recording paused"))

            Log.i(TAG, "Recording paused")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to pause recording", e)
        }
    }

    private fun resumeRecording() {
        if (!isRecording) return

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                mediaRecorder?.resume()
            }
            lastChunkTimestampMs = System.currentTimeMillis()
            startChunkTimer()

            // Update notification
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, createNotification("Recording in progress..."))

            Log.i(TAG, "Recording resumed")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to resume recording", e)
        }
    }

    private fun stopRecording() {
        if (!isRecording) return

        try {
            chunkTimer?.cancel()
            chunkTimer = null

            mediaRecorder?.apply {
                try {
                    stop()
                } catch (e: Exception) {
                    Log.w(TAG, "Error stopping recorder", e)
                }
                release()
            }
            mediaRecorder = null

            isRecording = false

            // FIX 3 & 6: Release audio focus and wake lock
            abandonAudioFocus()
            releaseWakeLock()

            Log.i(TAG, "Recording stopped: $currentRecordId, chunks: $chunkIndex")

        } catch (e: Exception) {
            Log.e(TAG, "Error stopping recording", e)
        } finally {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    // MARK: - Audio Focus Handling (FIX 3)

    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        handler.post {
            when (focusChange) {
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                    // Transient loss (e.g., phone call) — pause recording
                    if (isRecording && !isPausedByFocusLoss) {
                        Log.i(TAG, "Audio focus lost transiently, pausing recording")
                        isPausedByFocusLoss = true
                        pauseRecording()
                        broadcastInterruption("audio_focus_loss_transient")
                    }
                }
                AudioManager.AUDIOFOCUS_LOSS -> {
                    // Full loss — pause but don't kill (may be temporary)
                    if (isRecording && !isPausedByFocusLoss) {
                        Log.i(TAG, "Audio focus lost, pausing recording")
                        isPausedByFocusLoss = true
                        pauseRecording()
                        broadcastInterruption("audio_focus_loss")
                    }
                }
                AudioManager.AUDIOFOCUS_GAIN -> {
                    // Regained focus — resume if we paused for focus
                    if (isPausedByFocusLoss) {
                        Log.i(TAG, "Audio focus regained, resuming recording")
                        isPausedByFocusLoss = false
                        resumeRecording()
                        broadcastResume()
                    }
                }
            }
        }
    }

    private fun requestAudioFocus() {
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()

            audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(audioAttributes)
                .setOnAudioFocusChangeListener(audioFocusChangeListener, handler)
                .build()

            audioManager?.requestAudioFocus(audioFocusRequest!!)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager?.abandonAudioFocus(audioFocusChangeListener)
        }
        audioFocusRequest = null
        isPausedByFocusLoss = false
    }

    private fun broadcastInterruption(reason: String) {
        val intent = Intent(ACTION_RECORDING_INTERRUPTED).apply {
            putExtra(EXTRA_REASON, reason)
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    private fun broadcastResume() {
        val intent = Intent(ACTION_RECORDING_RESUMED).apply {
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    // MARK: - Wake Lock (FIX 6)

    private fun acquireWakeLock() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "SuisseNotes::RecordingWakeLock"
        ).apply {
            acquire(5 * 60 * 60 * 1000L) // 5-hour timeout
        }
        Log.d(TAG, "Wake lock acquired")
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) {
                it.release()
                Log.d(TAG, "Wake lock released")
            }
        }
        wakeLock = null
    }

    /**
     * Set callbacks for plugin communication
     */
    fun setCallbacks(
        onChunkSaved: ((Int, String) -> Unit)?,
        onError: ((String) -> Unit)?
    ) {
        this.onChunkSaved = onChunkSaved
        this.onError = onError
    }
}
