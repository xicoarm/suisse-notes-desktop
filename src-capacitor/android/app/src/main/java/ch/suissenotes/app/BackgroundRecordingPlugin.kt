package ch.suissenotes.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.nio.ByteBuffer

/**
 * BackgroundRecordingPlugin
 * Capacitor plugin that interfaces with ForegroundRecordingService
 */
@CapacitorPlugin(
    name = "BackgroundRecording",
    permissions = [
        Permission(
            alias = "microphone",
            strings = [Manifest.permission.RECORD_AUDIO]
        ),
        Permission(
            alias = "notification",
            strings = [Manifest.permission.POST_NOTIFICATIONS]
        )
    ]
)
class BackgroundRecordingPlugin : Plugin() {

    companion object {
        private const val TAG = "BackgroundRecording"
        private const val DEFAULT_AUDIO_FRAME_DURATION_US = 20_000L
        private const val MAX_REASONABLE_SAMPLE_DELTA_US = 1_000_000L
        private const val SAMPLE_BUFFER_SIZE = 1024 * 1024
    }

    private var pendingCall: PluginCall? = null

    private data class WebMRemuxResult(
        val chunkCount: Int,
        val durationUs: Long
    )

    // Broadcast receiver for recording death events from the foreground service
    private val recordingDeadReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ForegroundRecordingService.ACTION_RECORDING_DEAD) {
                val reason = intent.getStringExtra(ForegroundRecordingService.EXTRA_REASON) ?: "unknown"
                val chunkCount = intent.getIntExtra(ForegroundRecordingService.EXTRA_CHUNK_COUNT, 0)
                val lastChunkTimestampMs = intent.getLongExtra(ForegroundRecordingService.EXTRA_LAST_CHUNK_TIMESTAMP, 0L)

                val data = JSObject().apply {
                    put("reason", reason)
                    put("chunkCount", chunkCount)
                    put("lastChunkTimestampMs", lastChunkTimestampMs)
                }
                notifyListeners("recordingDead", data)
            }
        }
    }

    // FIX 3: Broadcast receiver for audio focus interruption events
    private val recordingInterruptedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ForegroundRecordingService.ACTION_RECORDING_INTERRUPTED) {
                val reason = intent.getStringExtra(ForegroundRecordingService.EXTRA_REASON) ?: "audio_focus"
                val data = JSObject().apply {
                    put("reason", reason)
                }
                notifyListeners("interrupted", data)
            }
        }
    }

    // FIX 3: Broadcast receiver for audio focus resume events
    private val recordingResumedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ForegroundRecordingService.ACTION_RECORDING_RESUMED) {
                notifyListeners("resumed", JSObject())
            }
        }
    }

    override fun load() {
        super.load()
        // Register broadcast receiver for recording death events
        val deadFilter = IntentFilter(ForegroundRecordingService.ACTION_RECORDING_DEAD)
        // FIX 3: Register receivers for audio focus interruption/resume events
        val interruptedFilter = IntentFilter(ForegroundRecordingService.ACTION_RECORDING_INTERRUPTED)
        val resumedFilter = IntentFilter(ForegroundRecordingService.ACTION_RECORDING_RESUMED)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(recordingDeadReceiver, deadFilter, Context.RECEIVER_NOT_EXPORTED)
            context.registerReceiver(recordingInterruptedReceiver, interruptedFilter, Context.RECEIVER_NOT_EXPORTED)
            context.registerReceiver(recordingResumedReceiver, resumedFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(recordingDeadReceiver, deadFilter)
            context.registerReceiver(recordingInterruptedReceiver, interruptedFilter)
            context.registerReceiver(recordingResumedReceiver, resumedFilter)
        }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        try {
            context.unregisterReceiver(recordingDeadReceiver)
        } catch (e: Exception) { /* Already unregistered */ }
        try {
            context.unregisterReceiver(recordingInterruptedReceiver)
        } catch (e: Exception) { /* Already unregistered */ }
        try {
            context.unregisterReceiver(recordingResumedReceiver)
        } catch (e: Exception) { /* Already unregistered */ }
    }

    @PluginMethod
    fun startRecording(call: PluginCall) {
        val recordId = call.getString("recordId")
        if (recordId == null) {
            call.reject("Missing recordId parameter")
            return
        }

        // Check permissions
        if (!checkRequiredPermissions()) {
            pendingCall = call
            requestAllPermissions(call, "permissionCallback")
            return
        }

        startRecordingService(recordId, call)
    }

    @PermissionCallback
    private fun permissionCallback(call: PluginCall) {
        if (checkRequiredPermissions()) {
            val recordId = call.getString("recordId")
            if (recordId != null) {
                startRecordingService(recordId, call)
            } else {
                call.reject("Missing recordId after permission grant")
            }
        } else {
            call.reject("Microphone permission is required for recording")
        }
    }


    private fun checkRequiredPermissions(): Boolean {
        val context = context ?: return false

        val hasMic = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        // Notification permission only required on Android 13+
        val hasNotification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

        return hasMic && hasNotification
    }

    private fun startRecordingService(recordId: String, call: PluginCall) {
        val context = context ?: run {
            call.reject("Context not available")
            return
        }

        try {
            val intent = Intent(context, ForegroundRecordingService::class.java).apply {
                action = ForegroundRecordingService.ACTION_START
                putExtra(ForegroundRecordingService.EXTRA_RECORD_ID, recordId)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }

            val result = JSObject().apply {
                put("success", true)
                put("recordId", recordId)
            }
            call.resolve(result)

        } catch (e: Exception) {
            call.reject("Failed to start recording: ${e.message}")
        }
    }

    @PluginMethod
    fun stopRecording(call: PluginCall) {
        val context = context ?: run {
            call.reject("Context not available")
            return
        }

        try {
            val intent = Intent(context, ForegroundRecordingService::class.java).apply {
                action = ForegroundRecordingService.ACTION_STOP
            }
            context.startService(intent)

            val result = JSObject().apply {
                put("success", true)
                put("recordId", ForegroundRecordingService.currentRecordId ?: "")
                put("chunkCount", ForegroundRecordingService.chunkIndex)
            }
            call.resolve(result)

        } catch (e: Exception) {
            call.reject("Failed to stop recording: ${e.message}")
        }
    }

    @PluginMethod
    fun pauseRecording(call: PluginCall) {
        val context = context ?: run {
            call.reject("Context not available")
            return
        }

        try {
            val intent = Intent(context, ForegroundRecordingService::class.java).apply {
                action = ForegroundRecordingService.ACTION_PAUSE
            }
            context.startService(intent)

            call.resolve(JSObject().apply { put("success", true) })

        } catch (e: Exception) {
            call.reject("Failed to pause recording: ${e.message}")
        }
    }

    @PluginMethod
    fun resumeRecording(call: PluginCall) {
        val context = context ?: run {
            call.reject("Context not available")
            return
        }

        try {
            val intent = Intent(context, ForegroundRecordingService::class.java).apply {
                action = ForegroundRecordingService.ACTION_RESUME
            }
            context.startService(intent)

            call.resolve(JSObject().apply { put("success", true) })

        } catch (e: Exception) {
            call.reject("Failed to resume recording: ${e.message}")
        }
    }

    @PluginMethod
    fun combineChunks(call: PluginCall) {
        val recordId = call.getString("recordId")
        if (recordId == null) {
            call.reject("Missing recordId parameter")
            return
        }

        // Run on background thread
        Thread {
            try {
                performCombineChunks(recordId, call)
            } catch (e: Exception) {
                Log.e(TAG, "combineChunks failed", e)
                call.reject("Failed to combine chunks: ${e.message}")
            }
        }.start()
    }

    private fun performCombineChunks(recordId: String, call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context not available")
            return
        }

        // Use same directory resolution as ForegroundRecordingService and Capacitor Directory.Documents
        val documentsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
            ?: ctx.filesDir
        val chunksDir = File(documentsDir, "recordings/$recordId/chunks")

        // Also check filesDir as fallback (old recordings may be there)
        val effectiveChunksDir = if (chunksDir.exists() && (chunksDir.listFiles()?.isNotEmpty() == true)) {
            chunksDir
        } else {
            val fallbackDir = File(ctx.filesDir, "recordings/$recordId/chunks")
            if (fallbackDir.exists() && (fallbackDir.listFiles()?.isNotEmpty() == true)) {
                fallbackDir
            } else {
                chunksDir // Use default, will fail gracefully below
            }
        }

        // List and sort chunk files — accept both .m4a and .webm
        val chunkFiles = effectiveChunksDir.listFiles()
            ?.filter { it.name.startsWith("chunk_") && (it.extension == "m4a" || it.extension == "webm") }
            ?.sortedBy { it.name }
            ?: emptyList()

        if (chunkFiles.isEmpty()) {
            call.reject("No audio chunks found in ${effectiveChunksDir.absolutePath}")
            return
        }

        // Detect format from the chunks found
        val isWebM = chunkFiles.first().extension == "webm"

        if (isWebM) {
            // WebM chunks from Android/Chromium can contain fresh EBML headers and
            // timestamps starting at zero. Binary concatenation creates malformed files
            // with repeated audio, so remux samples onto one monotonic timeline.
            val outputFile = File(documentsDir, "recordings/$recordId/combined.webm")

            if (outputFile.exists()) {
                outputFile.delete()
            }
            outputFile.parentFile?.mkdirs()

            try {
                val remuxResult = remuxWebMChunks(chunkFiles, outputFile)

                val fileSize = outputFile.length()
                val relativePath = "recordings/$recordId/combined.webm"
                val durationSeconds = remuxResult.durationUs / 1_000_000.0

                val result = JSObject().apply {
                    put("success", true)
                    put("outputPath", relativePath)
                    put("fileSize", fileSize)
                    put("chunkCount", remuxResult.chunkCount)
                    put("duration", durationSeconds)
                }
                call.resolve(result)

            } catch (e: Exception) {
                if (outputFile.exists()) outputFile.delete()
                Log.e(TAG, "Failed to combine WebM chunks", e)
                call.reject("Failed to combine WebM chunks: ${e.message}")
            }
        } else {
            // M4A chunks: use MediaMuxer for proper AAC merging
            val outputFile = File(documentsDir, "recordings/$recordId/combined.m4a")

            if (outputFile.exists()) {
                outputFile.delete()
            }
            outputFile.parentFile?.mkdirs()

            var muxer: MediaMuxer? = null
            var outputTrackIndex = -1
            var loadedChunkCount = 0
            var timeOffsetUs = 0L

            try {
                muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                var muxerStarted = false
                val bufferSize = 1024 * 1024 // 1MB buffer
                val buffer = ByteBuffer.allocate(bufferSize)
                val bufferInfo = MediaCodec.BufferInfo()

                for (chunkFile in chunkFiles) {
                    val extractor = MediaExtractor()
                    try {
                        extractor.setDataSource(chunkFile.absolutePath)

                        // Find audio track
                        var audioTrackIdx = -1
                        for (i in 0 until extractor.trackCount) {
                            val format = extractor.getTrackFormat(i)
                            val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
                            if (mime.startsWith("audio/")) {
                                audioTrackIdx = i
                                break
                            }
                        }

                        if (audioTrackIdx < 0) {
                            Log.w(TAG, "Skipping chunk with no audio track: ${chunkFile.name}")
                            continue
                        }

                        extractor.selectTrack(audioTrackIdx)
                        val format = extractor.getTrackFormat(audioTrackIdx)

                        // Add track to muxer on first valid chunk
                        if (!muxerStarted) {
                            outputTrackIndex = muxer.addTrack(format)
                            muxer.start()
                            muxerStarted = true
                        }

                        // Read and write samples, tracking max PTS for offset calculation
                        var chunkMaxPts = 0L
                        while (true) {
                            val sampleSize = extractor.readSampleData(buffer, 0)
                            if (sampleSize < 0) break

                            val sampleTime = extractor.sampleTime
                            if (sampleTime > chunkMaxPts) chunkMaxPts = sampleTime

                            bufferInfo.offset = 0
                            bufferInfo.size = sampleSize
                            bufferInfo.presentationTimeUs = sampleTime + timeOffsetUs
                            bufferInfo.flags = extractor.sampleFlags

                            muxer.writeSampleData(outputTrackIndex, buffer, bufferInfo)
                            extractor.advance()
                        }

                        // Offset next chunk's timestamps after this chunk's end (+20ms gap)
                        timeOffsetUs += chunkMaxPts + 20000

                        loadedChunkCount++
                    } catch (e: Exception) {
                        Log.w(TAG, "Error processing chunk ${chunkFile.name}: ${e.message}")
                        continue
                    } finally {
                        extractor.release()
                    }
                }

                if (!muxerStarted || loadedChunkCount == 0) {
                    muxer.release()
                    outputFile.delete()
                    call.reject("Could not read any audio chunks")
                    return
                }

                muxer.stop()
                muxer.release()
                muxer = null

                val fileSize = outputFile.length()
                val relativePath = "recordings/$recordId/combined.m4a"
                // Total duration from accumulated timestamps (microseconds to seconds)
                val totalDurationSeconds = timeOffsetUs / 1_000_000.0

                val result = JSObject().apply {
                    put("success", true)
                    put("outputPath", relativePath)
                    put("fileSize", fileSize)
                    put("chunkCount", loadedChunkCount)
                    put("duration", totalDurationSeconds)
                }
                call.resolve(result)

            } catch (e: Exception) {
                muxer?.release()
                if (outputFile.exists()) outputFile.delete()
                Log.e(TAG, "Failed to combine chunks", e)
                call.reject("Failed to combine chunks: ${e.message}")
            }
        }
    }

    private fun remuxWebMChunks(chunkFiles: List<File>, outputFile: File): WebMRemuxResult {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            throw IllegalStateException("WebM remuxing requires Android 5.0 or newer")
        }

        var muxer: MediaMuxer? = null
        var muxerStarted = false
        var outputTrackIndex = -1
        var loadedChunkCount = 0
        var timeOffsetUs = 0L
        var lastWrittenPtsUs = -1L
        var frameDurationUs = DEFAULT_AUDIO_FRAME_DURATION_US
        val buffer = ByteBuffer.allocate(SAMPLE_BUFFER_SIZE)
        val bufferInfo = MediaCodec.BufferInfo()

        try {
            muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM)

            for (chunkFile in chunkFiles) {
                val extractor = MediaExtractor()
                try {
                    extractor.setDataSource(chunkFile.absolutePath)

                    var audioTrackIdx = -1
                    for (i in 0 until extractor.trackCount) {
                        val format = extractor.getTrackFormat(i)
                        val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
                        if (mime.startsWith("audio/")) {
                            audioTrackIdx = i
                            break
                        }
                    }

                    if (audioTrackIdx < 0) {
                        Log.w(TAG, "Skipping WebM chunk with no audio track: ${chunkFile.name}")
                        continue
                    }

                    extractor.selectTrack(audioTrackIdx)
                    val format = extractor.getTrackFormat(audioTrackIdx)

                    if (!muxerStarted) {
                        outputTrackIndex = muxer.addTrack(format)
                        muxer.start()
                        muxerStarted = true
                    }

                    var firstSampleTimeUs: Long? = null
                    var previousSampleTimeUs = -1L
                    var samplesWritten = 0

                    while (true) {
                        buffer.clear()
                        val sampleSize = extractor.readSampleData(buffer, 0)
                        if (sampleSize < 0) break

                        var sampleTimeUs = extractor.sampleTime
                        if (sampleTimeUs < 0) {
                            sampleTimeUs = if (previousSampleTimeUs >= 0) {
                                previousSampleTimeUs + frameDurationUs
                            } else {
                                0L
                            }
                        }

                        if (firstSampleTimeUs == null) {
                            firstSampleTimeUs = sampleTimeUs
                        }

                        if (previousSampleTimeUs >= 0) {
                            val sampleDeltaUs = sampleTimeUs - previousSampleTimeUs
                            if (sampleDeltaUs in 1 until MAX_REASONABLE_SAMPLE_DELTA_US) {
                                frameDurationUs = sampleDeltaUs
                            }
                        }

                        val chunkStartUs = firstSampleTimeUs ?: sampleTimeUs
                        val normalizedPtsUs = (sampleTimeUs - chunkStartUs).coerceAtLeast(0L)
                        var outputPtsUs = timeOffsetUs + normalizedPtsUs
                        if (outputPtsUs <= lastWrittenPtsUs) {
                            outputPtsUs = lastWrittenPtsUs + frameDurationUs
                        }

                        bufferInfo.set(0, sampleSize, outputPtsUs, extractor.sampleFlags)
                        muxer.writeSampleData(outputTrackIndex, buffer, bufferInfo)

                        lastWrittenPtsUs = outputPtsUs
                        previousSampleTimeUs = sampleTimeUs
                        samplesWritten++
                        extractor.advance()
                    }

                    if (samplesWritten > 0) {
                        loadedChunkCount++
                        timeOffsetUs = lastWrittenPtsUs + frameDurationUs
                    } else {
                        Log.w(TAG, "Skipping empty WebM chunk: ${chunkFile.name}")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Error remuxing WebM chunk ${chunkFile.name}: ${e.message}")
                    continue
                } finally {
                    extractor.release()
                }
            }

            if (!muxerStarted || loadedChunkCount == 0) {
                throw IllegalStateException("Could not read any audio chunks")
            }

            muxer.stop()
            muxer.release()
            muxer = null

            return WebMRemuxResult(
                chunkCount = loadedChunkCount,
                durationUs = (lastWrittenPtsUs + frameDurationUs).coerceAtLeast(0L)
            )
        } finally {
            try {
                muxer?.release()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to release WebM muxer: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun startForegroundService(call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context not available")
            return
        }

        try {
            val intent = Intent(ctx, ForegroundRecordingService::class.java).apply {
                action = ForegroundRecordingService.ACTION_NOTIFICATION_ONLY
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to start foreground service: ${e.message}")
        }
    }

    @PluginMethod
    fun stopForegroundService(call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context not available")
            return
        }

        try {
            val intent = Intent(ctx, ForegroundRecordingService::class.java)
            ctx.stopService(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to stop foreground service: ${e.message}")
        }
    }

    @PluginMethod
    fun isBatteryOptimized(call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context not available")
            return
        }
        val powerManager = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val isIgnoring = powerManager.isIgnoringBatteryOptimizations(ctx.packageName)
        val result = JSObject().apply {
            put("isOptimized", !isIgnoring)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun requestBatteryOptimizationExemption(call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context not available")
            return
        }
        val powerManager = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (powerManager.isIgnoringBatteryOptimizations(ctx.packageName)) {
            call.resolve(JSObject().apply { put("alreadyExempt", true) })
            return
        }
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${ctx.packageName}")
            }
            activity.startActivity(intent)
            call.resolve(JSObject().apply { put("alreadyExempt", false) })
        } catch (e: Exception) {
            call.reject("Failed to request battery optimization exemption: ${e.message}")
        }
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to open app settings: ${e.message}")
        }
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val lastChunkTs = ForegroundRecordingService.lastChunkTimestampMs
        val secondsSinceLastChunk = if (lastChunkTs > 0) {
            (System.currentTimeMillis() - lastChunkTs) / 1000.0
        } else {
            0.0
        }

        val result = JSObject().apply {
            put("isRecording", ForegroundRecordingService.isRecording)
            put("chunkIndex", ForegroundRecordingService.chunkIndex)
            put("recordId", ForegroundRecordingService.currentRecordId ?: "")
            put("secondsSinceLastChunk", secondsSinceLastChunk)
            put("lastChunkTimestampMs", lastChunkTs)
        }
        call.resolve(result)
    }
}
