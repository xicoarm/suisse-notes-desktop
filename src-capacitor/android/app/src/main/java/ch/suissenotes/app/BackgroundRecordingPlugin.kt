package ch.suissenotes.app

import android.Manifest
import android.content.Intent
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
        val result = JSObject().apply {
            put("isRecording", ForegroundRecordingService.isRecording)
            put("chunkIndex", ForegroundRecordingService.chunkIndex)
            put("recordId", ForegroundRecordingService.currentRecordId ?: "")
        }
        call.resolve(result)
    }
}
