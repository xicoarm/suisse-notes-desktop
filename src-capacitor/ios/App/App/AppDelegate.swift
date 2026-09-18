import UIKit
import Capacitor
#if canImport(Sentry)
import Sentry
#endif

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        startCrashReporting()
        return true
    }

    /// Native crash, app-hang and out-of-memory reporting.
    ///
    /// The WebView layer reports its own errors over HTTPS, but it cannot
    /// report a process that died: a native crash in the recording plugin, a
    /// watchdog kill during a long meeting, an out-of-memory termination in the
    /// background. Those were only ever guessed at afterwards from a heuristic
    /// "previous session ended unexpectedly" message. This starts before the
    /// WebView, so a crash during startup is reported too.
    private func startCrashReporting() {
        #if canImport(Sentry)
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info?["CFBundleVersion"] as? String ?? "unknown"
        SentrySDK.start { options in
            options.dsn = "https://f5f1d2b53d297a64e9b76ca26d2d8397@o4510659364716544.ingest.de.sentry.io/4510958727462992"
            // Same release name the WebView layer uses, so a native crash and
            // the JavaScript breadcrumbs around it belong to one release.
            options.releaseName = "ch.suissenotes.mobile@\(version)"
            options.dist = build
            options.environment = "production"
            // The WebView layer already reports one session per app run.
            options.enableAutoSessionTracking = false
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 5
            options.enableWatchdogTerminationTracking = true
            // This app's screens show meeting content and transcripts.
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.tracesSampleRate = 0
            options.enableAutoBreadcrumbTracking = true
        }
        #endif
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
