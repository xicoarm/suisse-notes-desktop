#import <Capacitor/Capacitor.h>

// Define the plugin using the CAP_PLUGIN Macro
CAP_PLUGIN(BackgroundRecordingPlugin, "BackgroundRecording",
    CAP_PLUGIN_METHOD(startRecording, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopRecording, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(pauseRecording, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(resumeRecording, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getStatus, CAPPluginReturnPromise);
)
