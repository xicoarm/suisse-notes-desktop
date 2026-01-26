package ch.suissenotes.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BackgroundRecording",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { "android.permission.POST_NOTIFICATIONS" }
        )
    }
)
public class BackgroundRecordingPlugin extends Plugin {
    private static final String TAG = "BackgroundRecording";
    private static final String CHANNEL_ID = "recording_channel";
    private static final int NOTIFICATION_ID = 9999;

    @Override
    public void load() {
        super.load();
        createNotificationChannel();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Recording",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Shows when recording is active");
            channel.setShowBadge(true);

            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
                Log.d(TAG, "Notification channel created");
            }
        }
    }

    @PluginMethod
    public void startForegroundService(PluginCall call) {
        Log.d(TAG, "startForegroundService called");

        // Check and request permission on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getActivity().checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != PackageManager.PERMISSION_GRANTED) {
                Log.d(TAG, "Requesting notification permission");
                requestPermissionForAlias("notifications", call, "permissionCallback");
                return;
            }
        }

        showNotification(call);
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        Log.d(TAG, "Permission callback");
        showNotification(call);
    }

    private void showNotification(PluginCall call) {
        try {
            Log.d(TAG, "Showing notification");

            Intent intent = new Intent(getContext(), getActivity().getClass());
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);

            PendingIntent pendingIntent = PendingIntent.getActivity(
                getContext(), 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Suisse Notes")
                .setContentText("Aufnahme läuft...")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(pendingIntent);

            NotificationManagerCompat notificationManager = NotificationManagerCompat.from(getContext());

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (getActivity().checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        == PackageManager.PERMISSION_GRANTED) {
                    notificationManager.notify(NOTIFICATION_ID, builder.build());
                    Log.d(TAG, "Notification shown (with permission)");
                } else {
                    Log.d(TAG, "No notification permission");
                }
            } else {
                notificationManager.notify(NOTIFICATION_ID, builder.build());
                Log.d(TAG, "Notification shown");
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Error showing notification", e);
            call.reject("Error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        try {
            NotificationManagerCompat notificationManager = NotificationManagerCompat.from(getContext());
            notificationManager.cancel(NOTIFICATION_ID);
            Log.d(TAG, "Notification cancelled");

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Error cancelling notification", e);
            call.reject("Error: " + e.getMessage());
        }
    }
}
