package ch.suissenotes.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.Timer
import java.util.TimerTask

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

        // Broadcast action for recording death
        const val ACTION_RECORDING_DEAD = "ch.suissenotes.app.RECORDING_DEAD"
        const val EXTRA_REASON = "reason"
        const val EXTRA_CHUNK_COUNT = "chunkCount"
        const val EXTRA_LAST_CHUNK_TIMESTAMP = "lastChunkTimestampMs"
    }

    private var mediaRecorder: MediaRecorder? = null
    private var chunkTimer: Timer? = null
    private var chunksDirectory: File? = null
    private var currentChunkFile: File? = null
    private val handler = Handler(Looper.getMainLooper())

    // Callbacks for plugin communication
    private var onChunkSaved: ((Int, String) -> Unit)? = null
    private var onError: ((String) -> Unit)? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val recordId = intent.getStringExtra(EXTRA_RECORD_ID)
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

    override fun onDestroy() {
        super.onDestroy()
        if (isRecording) {
            // Service being killed while recording - broadcast death
            broadcastRecordingDeath("service_destroyed")
        }
        stopRecording()
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
            // Create chunks directory
            val documentsDir = getExternalFilesDir(null) ?: filesDir
            chunksDirectory = File(documentsDir, "recordings/$recordId/chunks").apply {
                mkdirs()
            }

            currentRecordId = recordId
            chunkIndex = 0
            lastChunkTimestampMs = System.currentTimeMillis()

            // Start foreground service
            startForeground(NOTIFICATION_ID, createNotification("Recording in progress..."))

            // Start first chunk
            startNewChunk()

            isRecording = true

            // Start chunk rotation timer
            startChunkTimer()

            Log.i(TAG, "Recording started: $recordId")

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording", e)
            onError?.invoke("Failed to start recording: ${e.message}")
            stopSelf()
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
        startNewChunk()
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

            Log.i(TAG, "Recording stopped: $currentRecordId, chunks: $chunkIndex")

        } catch (e: Exception) {
            Log.e(TAG, "Error stopping recording", e)
        } finally {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
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
