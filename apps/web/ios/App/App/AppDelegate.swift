import AVFoundation
import Capacitor
import UIKit
import os.log

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        application.isIdleTimerDisabled = true
        KioskDiagnosticsRecorder.shared.start()
        requestCameraAccessUpFront()
        configureAudioSession()
        return true
    }

    // The panel makes sound (the photo booth's shutter and countdown, and
    // whatever comes later), and under the default audio session category all of
    // it is silenced by the iPad's physical mute switch. That switch cannot be
    // read or set from code - there is no API for it at all - so a panel muted
    // by a flick of a switch nobody remembers touching would be undiagnosable
    // from the app's side.
    //
    // `.playback` is the category for audio that IS the point rather than
    // accompanying something else, and iOS exempts it from the mute switch. For
    // a wall fixture that is the honest description: its sounds are deliberate,
    // and the volume slider in Settings is the way to silence it.
    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Non-fatal: sound still plays, it just obeys the mute switch again.
            os_log("kiosk audio session setup failed: %@", error.localizedDescription)
        }
    }

    // Wake-photo bursts call getUserMedia from the webview mid-wake, and WebKit
    // denies instantly (NotAllowedError) unless the app-level camera permission
    // is already granted - on the kiosk panel the TCC prompt cannot be answered
    // mid-wake (frontend_log source=wake, "camera open failed" on every wake).
    // Requesting up front makes the prompt appear once, deterministically, at
    // app launch where someone standing at the panel can accept it; after that
    // the grant persists across builds. If camera is already denied in Settings
    // this is a silent no-op (no prompt), so the os_log status line is the way
    // to tell "never asked" from "denied on the device".
    private func requestCameraAccessUpFront() {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        os_log("kiosk camera authorization status: %d", status.rawValue)
        guard status == .notDetermined else { return }
        AVCaptureDevice.requestAccess(for: .video) { granted in
            os_log("kiosk camera access prompt result: granted=%d", granted)
        }
    }

    func applicationWillResignActive(_: UIApplication) {
        KioskDiagnosticsRecorder.shared.transition(to: .inactive)
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_: UIApplication) {
        KioskDiagnosticsRecorder.shared.transition(to: .background)
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_: UIApplication) {
        KioskDiagnosticsRecorder.shared.transition(to: .foreground)
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_: UIApplication) {
        KioskDiagnosticsRecorder.shared.transition(to: .active)
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_: UIApplication) {
        KioskDiagnosticsRecorder.shared.transition(to: .terminating)
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // MARK: - APNs

    // iOS delivers the device token to the AppDelegate, and the Capacitor
    // PushNotifications plugin only learns about it through these NSNotification
    // posts. Without them the token arrives here and goes nowhere: the JS
    // `registration` listener never fires, `registrationError` never fires
    // either, and registration appears to hang forever with no error anywhere.
    // That is precisely what happened - permission granted, register() called,
    // device_push_token empty, and no log line on any path.
    // These two methods are stock Capacitor boilerplate that this project was
    // missing because it never used push before.
    func application(_: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
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
