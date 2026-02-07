package ch.suissenotes.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

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

    private var pendingCall: PluginCall? = null

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

    override fun load() {
        super.load()
        // Register broadcast receiver for recording death events
        val filter = IntentFilter(ForegroundRecordingService.ACTION_RECORDING_DEAD)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(recordingDeadReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(recordingDeadReceiver, filter)
        }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        try {
            context.unregisterReceiver(recordingDeadReceiver)
        } catch (e: Exception) {
            // Already unregistered
        }
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
