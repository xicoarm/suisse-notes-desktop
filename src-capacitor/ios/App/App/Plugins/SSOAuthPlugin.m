#import <Capacitor/Capacitor.h>

// Capacitor plugin registration. The first arg is the Swift class
// (@objc(SSOAuthPlugin)), the second is the JS-visible plugin name
// used by registerPlugin('SSOAuth') in src/services/ssoAuth.js.
CAP_PLUGIN(SSOAuthPlugin, "SSOAuth",
    CAP_PLUGIN_METHOD(startAuth, CAPPluginReturnPromise);
)
