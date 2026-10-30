#import <Capacitor/Capacitor.h>

// Capacitor plugin registration. The first arg is the Swift class
// (@objc(SecureTokenStorePlugin)), the second is the JS-visible plugin name
// used by registerPlugin('SecureTokenStore') in src/services/secureStorage.js.
CAP_PLUGIN(SecureTokenStorePlugin, "SecureTokenStore",
    CAP_PLUGIN_METHOD(get, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(set, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(remove, CAPPluginReturnPromise);
)
