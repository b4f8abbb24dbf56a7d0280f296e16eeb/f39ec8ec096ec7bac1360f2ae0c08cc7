use std::cell::{OnceCell, RefCell};
use std::path::Path;

use objc2::rc::{Allocated, Retained};
use objc2::runtime::AnyClass;
use objc2::{ClassType, Ivars, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSBundle, NSObject, NSObjectProtocol, NSString};
use objc2_quartz_core::CAMetalLayer;
use objc2_ui_kit::{
    UIApplication, UIApplicationDelegate, UIColor, UILabel, UIScene, UISceneConfiguration,
    UISceneConnectionOptions, UISceneDelegate, UISceneSession, UIView, UIViewController, UIWindow,
    UIWindowScene, UIWindowSceneDelegate,
};

use crate::Paths;

/// One native game session, called only on the main thread by UIKit.
/// Guest execution must use its own threads. No callback may block the UI loop.
pub trait Session {
    /// Release held input and pause rendering/audio when inactive, resume when active.
    fn set_active(&mut self, active: bool);
    /// The drawable size changed. Width/height are physical pixels, never points.
    fn resize(&mut self, width: u32, height: u32);
    /// Disconnect permanently. Must quiesce guest/GPU/audio work before releasing memory.
    fn stop(&mut self);
}

/// Create the guest session and attach its Metal device/presenter to the retained layer.
/// Returning an error displays it instead of claiming a game started.
pub type SessionFactory = fn(Retained<CAMetalLayer>, Paths) -> Result<Box<dyn Session>, String>;

thread_local! {
    static FACTORY: OnceCell<SessionFactory> = const { OnceCell::new() };
    static SESSION: RefCell<Option<Box<dyn Session>>> = const { RefCell::new(None) };
    static USED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn active(on: bool) {
    SESSION.with_borrow_mut(|s| {
        if let Some(s) = s {
            s.set_active(on);
        }
    });
}

fn stop() {
    SESSION.with_borrow_mut(|s| {
        if let Some(mut s) = s.take() {
            s.stop();
        }
    });
}

// SAFETY: UIView owns the layer, all access uses UIKit's main thread, and this
// subclass has no custom destructor or shared mutable Objective-C state.
define_class!(
    #[unsafe(super(UIView))]
    #[name = "Nx2ipaMetalView"]
    struct MetalView;

    impl MetalView {
        #[unsafe(method(layerClass))]
        fn layer_class() -> &'static AnyClass { CAMetalLayer::class() }

        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // SAFETY: the superclass implements this no-argument UIView method.
            unsafe { let _: () = msg_send![super(self), layoutSubviews]; }
            let scale = self.window().map(|w| w.screen().scale()).unwrap_or(1.0);
            let size = self.bounds().size;
            let width = (size.width * scale).max(0.0).min(u32::MAX as f64) as u32;
            let height = (size.height * scale).max(0.0).min(u32::MAX as f64) as u32;
            if let Ok(layer) = self.layer().downcast::<CAMetalLayer>() {
                layer.setContentsScale(scale);
                layer.setDrawableSize(CGSize { width: width as f64, height: height as f64 });
            }
            if width > 0 && height > 0 {
                SESSION.with_borrow_mut(|s| { if let Some(s) = s { s.resize(width, height); } });
            }
        }
    }
    unsafe impl NSObjectProtocol for MetalView {}
);

fn show_error(controller: &UIViewController, message: &str, mtm: MainThreadMarker) {
    let label = UILabel::new(mtm);
    label.setText(Some(&NSString::from_str(message)));
    label.setNumberOfLines(0);
    // SAFETY: the live UIColor is retained by the UILabel property.
    unsafe {
        label.setTextColor(Some(&UIColor::whiteColor()));
    }
    label.setBackgroundColor(Some(&UIColor::blackColor()));
    controller.setView(Some(&label));
    eprintln!("nx2ipa: {message}");
}

// SAFETY: UIKit creates this delegate on the main thread. Its retained window
// and session are not shared across threads; all ivars are initialized in init.
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "Nx2ipaSceneDelegate"]
    struct SceneDelegate { window: RefCell<Option<Retained<UIWindow>>> }

    impl SceneDelegate {
        #[unsafe(method(init))]
        fn init(this: Allocated<Self>) -> Retained<Self> {
            let this = this.set_ivars(Ivars::<Self> { window: RefCell::new(None) });
            // SAFETY: NSObject initialization of the allocated delegate.
            unsafe { msg_send![super(this), init] }
        }
    }
    unsafe impl NSObjectProtocol for SceneDelegate {}
    unsafe impl UIWindowSceneDelegate for SceneDelegate {}
    unsafe impl UISceneDelegate for SceneDelegate {
        #[unsafe(method(scene:willConnectToSession:options:))]
        fn connect(&self, scene: &UIScene, _session: &UISceneSession, _options: &UISceneConnectionOptions) {
            let Some(scene) = scene.downcast_ref::<UIWindowScene>() else { return; };
            let mtm = self.mtm();
            let window = UIWindow::initWithWindowScene(UIWindow::alloc(mtm), scene);
            let controller = UIViewController::new(mtm);
            window.setRootViewController(Some(&controller));
            let view: Retained<MetalView> = unsafe {
                // SAFETY: MetalView inherits UIView's designated frame initializer.
                msg_send![MetalView::alloc(mtm), initWithFrame: window.bounds()]
            };
            controller.setView(Some(&view));
            window.makeKeyAndVisible();
            *self.window().borrow_mut() = Some(window);

            let result = (|| {
                if USED.with(|used| used.replace(true)) {
                    return Err("This process already started a game session. Relaunch the app to restart.".to_owned());
                }
                let bundle = NSBundle::mainBundle().bundlePath().to_string();
                let home = std::env::var_os("HOME").ok_or("UIKit did not provide a sandbox home")?;
                let paths = Paths::new(Path::new(&bundle), Path::new(&home))?;
                paths.prepare()?;
                let layer = view.layer().downcast::<CAMetalLayer>()
                    .map_err(|_| "The view has no CAMetalLayer")?;
                let factory = FACTORY.with(|f| f.get().copied()).ok_or("No native game session was linked")?;
                let session = factory(layer, paths)?;
                SESSION.with_borrow_mut(|s| *s = Some(session));
                view.setNeedsLayout();
                Ok::<(), String>(())
            })();
            if let Err(error) = result { show_error(&controller, &error, mtm); }
        }
        #[unsafe(method(sceneDidBecomeActive:))]
        fn became_active(&self, _scene: &UIScene) { active(true); }
        #[unsafe(method(sceneWillResignActive:))]
        fn resigned_active(&self, _scene: &UIScene) { active(false); }
        #[unsafe(method(sceneDidDisconnect:))]
        fn disconnected(&self, _scene: &UIScene) { stop(); self.window().borrow_mut().take(); }
    }
);

// SAFETY: NSObject has no extra subclassing requirements and UIKit exclusively
// invokes this application delegate on the main thread.
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "Nx2ipaAppDelegate"]
    struct AppDelegate;

    unsafe impl NSObjectProtocol for AppDelegate {}
    unsafe impl UIApplicationDelegate for AppDelegate {
        #[unsafe(method(application:configurationForConnectingSceneSession:options:))]
        fn scene_config(
            &self,
            _app: &UIApplication,
            session: &UISceneSession,
            _options: &UISceneConnectionOptions,
        ) -> Retained<UISceneConfiguration> {
            let config = UISceneConfiguration::configurationWithName_sessionRole(
                Some(&NSString::from_str("Game")),
                &session.role(),
                self.mtm(),
            );
            // SAFETY: SceneDelegate implements UIWindowSceneDelegate and UISceneDelegate.
            unsafe {
                config.setDelegateClass(Some(SceneDelegate::class()));
            }
            config
        }
        #[unsafe(method(applicationWillTerminate:))]
        fn terminating(&self, _app: &UIApplication) {
            stop();
        }
    }
);

/// Enter UIKit on the main thread, using the linked native session factory.
/// This does not provide an nxkit loader, GPU backend, or audio implementation.
pub fn run(factory: SessionFactory) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("UIKit must start on the main thread")?;
    FACTORY
        .with(|f| f.set(factory))
        .map_err(|_| "UIKit has already started")?;
    let delegate = NSString::from_class(AppDelegate::class());
    UIApplication::main(None, Some(&delegate), mtm)
}
