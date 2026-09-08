import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var browser: WebController!
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        browser = WebController()
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.overrideUserInterfaceStyle = .dark
        window?.rootViewController = browser
        window?.makeKeyAndVisible()
        return true
    }
    func applicationDidBecomeActive(_ application: UIApplication) { browser.resume() }
    func applicationDidEnterBackground(_ application: UIApplication) { browser.pause() }
}
