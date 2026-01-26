package ch.suissenotes.app;

import android.content.Intent;
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

        // Allow mixed content (HTTP resources on HTTPS pages) - needed for dev mode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Set up WebChromeClient for microphone permissions AND file chooser
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    // Grant all requested permissions (microphone, camera if needed)
                    request.grant(request.getResources());
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
