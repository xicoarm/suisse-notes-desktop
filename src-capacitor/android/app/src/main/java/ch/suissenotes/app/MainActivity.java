package ch.suissenotes.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // File chooser callback for handling file input elements
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the BackgroundRecording plugin for native recording
        registerPlugin(BackgroundRecordingPlugin.class);

        super.onCreate(savedInstanceState);

        // Get WebView and enable settings required for mediaDevices API
        WebView webView = getBridge().getWebView();
        WebSettings webSettings = webView.getSettings();

        // Enable JavaScript (should already be enabled by Capacitor, but ensure it)
        webSettings.setJavaScriptEnabled(true);

        // Enable media playback without user gesture (for audio recording)
        webSettings.setMediaPlaybackRequiresUserGesture(false);

        // Allow file access for recordings
        webSettings.setAllowFileAccess(true);
        webSettings.setAllowContentAccess(true);

        // Enable DOM storage for app state
        webSettings.setDomStorageEnabled(true);

        // Mixed content (HTTP resources inside the HTTPS app origin) is only
        // ever needed by the live-reload dev server. Production builds serve
        // the bundle from https://localhost and talk HTTPS to the API, so the
        // permissive mode was pure attack surface there. Debuggable builds
        // keep the old behaviour.
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        webSettings.setMixedContentMode(
            debuggable ? WebSettings.MIXED_CONTENT_ALWAYS_ALLOW : WebSettings.MIXED_CONTENT_NEVER_ALLOW
        );

        // Fix: Android system navigation bar overlaps the app's bottom tab bar.
        // CSS env(safe-area-inset-bottom) returns 0 on Android WebView, and
        // WindowInsets are not reliably dispatched inside Capacitor's WebView.
        // Solution: read the actual nav bar height from system resources and
        // inject it as a CSS variable so the web layer can use it.
        webView.post(() -> {
            int navBarHeight = 0;
            int resourceId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            if (resourceId > 0) {
                navBarHeight = getResources().getDimensionPixelSize(resourceId);
            }
            float density = getResources().getDisplayMetrics().density;
            int navBarDp = Math.round(navBarHeight / density);
            webView.evaluateJavascript(
                "document.documentElement.style.setProperty('--android-nav-bar-height', '" + navBarDp + "px')",
                null
            );
        });

        // Set up WebChromeClient for microphone permissions AND file chooser
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    // Only the app's own origin (https://localhost, the Capacitor
                    // bundle host) may capture audio/video. Previously EVERY
                    // requested resource was granted to ANY origin the WebView
                    // happened to be on.
                    Uri origin = request.getOrigin();
                    String host = origin != null ? origin.getHost() : null;
                    boolean isAppOrigin = host != null && (host.equals("localhost") || host.endsWith(".localhost"));
                    if (!isAppOrigin) {
                        Log.w("MainActivity", "Denied WebView permission request from origin " + origin);
                        request.deny();
                        return;
                    }
                    java.util.ArrayList<String> granted = new java.util.ArrayList<>();
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                                || PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            granted.add(resource);
                        }
                    }
                    if (granted.isEmpty()) {
                        request.deny();
                    } else {
                        request.grant(granted.toArray(new String[0]));
                    }
                });
            }

            // Handle file input elements - THIS IS REQUIRED for <input type="file"> to work
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                            FileChooserParams fileChooserParams) {
                // Store the callback
                MainActivity.this.filePathCallback = filePathCallback;

                // Create intent for file selection
                android.content.Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                } catch (android.content.ActivityNotFoundException e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    String dataString = data.getDataString();
                    if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        }
    }
}
