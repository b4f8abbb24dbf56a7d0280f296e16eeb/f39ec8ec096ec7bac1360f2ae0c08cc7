use std::cell::{OnceCell, RefCell};
use std::path::Path;

use objc2::rc::{Allocated, Retained};
use objc2::runtime::AnyClass;
use objc2::{ClassType, Ivars, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_core_foundation::{CGRect, CGSize};
use objc2_foundation::{NSBundle, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_quartz_core::CAMetalLayer;
use objc2_ui_kit::{
    UIApplication, UIApplicationDelegate, UIColor, UIEvent, UILabel, UIScene, UISceneConfiguration,
    UISceneConnectionOptions, UISceneDelegate, UISceneSession, UITouch, UIView, UIViewController,
    UIWindow, UIWindowScene, UIWindowSceneDelegate,
};

use crate::{
    Paths, Touch,
    touch::{Touches, normalize},
};

/// One native game session, called only on the main thread by UIKit.
/// Guest execution must use its own threads. No callback may block the UI loop.
pub trait Session {
    /// Release held input and pause rendering/audio when inactive, resume when active.
    fn set_active(&mut self, active: bool);
    /// The drawable size changed. Width/height are physical pixels, never points.
    fn resize(&mut self, width: u32, height: u32);
    /// Current active fingers, in normalized visible-picture coordinates.
    fn touches(&mut self, points: &[Touch]);
    /// Return Some(width/height) only if presentation actually uses centered
    /// aspect-fit letterboxing. The pinned nxkit blit fills the whole drawable,
    /// so its correct default is None, not an assumed 16:9 touch rectangle.
    fn picture_aspect(&self) -> Option<f64> {
        None
    }
    /// Disconnect permanently. Must quiesce guest/GPU/audio work before releasing memory.
    fn stop(&mut self);
}

/// Create the guest session and attach its Metal device/presenter to the retained layer.
/// The third argument is UIKit's reported maximum FPS, not measured/adaptive FPS.
/// Returning an error displays it instead of claiming a game started.
pub type SessionFactory =
    fn(Retained<CAMetalLayer>, Paths, u32) -> Result<Box<dyn Session>, String>;

thread_local! {
    static FACTORY: OnceCell<SessionFactory> = const { OnceCell::new() };
    static SESSION: RefCell<Option<Box<dyn Session>>> = const { RefCell::new(None) };
    static ACTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static USED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn active(on: bool) {
    ACTIVE.with(|active| active.set(on));
    SESSION.with_borrow_mut(|s| {
        if let Some(s) = s {
            if !on {
                s.touches(&[]);
            }
            s.set_active(on);
        }
    });
}

fn stop() {
    ACTIVE.with(|active| active.set(false));
    SESSION.with_borrow_mut(|s| {
        if let Some(mut s) = s.take() {
            s.touches(&[]);
            s.stop();
        }
    });
}

// SAFETY: UIView owns the layer, all access uses UIKit's main thread, and this
// subclass has no custom destructor or shared mutable Objective-C state.
define_class!(
    #[unsafe(super(UIView))]
    #[name = "Nx2ipaMetalView"]
    struct MetalView { touches: RefCell<Touches>, touch_size: std::cell::Cell<(f64, f64)> }

    impl MetalView {
        #[unsafe(method(initWithFrame:))]
        fn init_with_frame(this: Allocated<Self>, frame: CGRect) -> Retained<Self> {
            let this = this.set_ivars(Ivars::<Self> { touches: RefCell::new(Touches::default()), touch_size: std::cell::Cell::new((0.0, 0.0)) });
            // SAFETY: initialize UIView after initializing the Rust ivars.
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }
        #[unsafe(method(touchesBegan:withEvent:))]
        fn began(&self, touches: &NSSet<UITouch>, _event: Option<&UIEvent>) { self.update_touches(touches, 0); }
        #[unsafe(method(touchesMoved:withEvent:))]
        fn moved(&self, touches: &NSSet<UITouch>, _event: Option<&UIEvent>) { self.update_touches(touches, 1); }
        #[unsafe(method(touchesEnded:withEvent:))]
        fn ended(&self, touches: &NSSet<UITouch>, _event: Option<&UIEvent>) { self.update_touches(touches, 2); }
        #[unsafe(method(touchesCancelled:withEvent:))]
        fn cancelled(&self, touches: &NSSet<UITouch>, _event: Option<&UIEvent>) { self.update_touches(touches, 2); }

        #[unsafe(method(layerClass))]
        fn layer_class() -> &'static AnyClass { CAMetalLayer::class() }

        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // SAFETY: the superclass implements this no-argument UIView method.
            unsafe { let _: () = msg_send![super(self), layoutSubviews]; }
            let scale = self.window().map(|w| w.screen().scale()).unwrap_or(1.0);
            let size = self.bounds().size;
            if self.touch_size().replace((size.width, size.height)) != (size.width, size.height) {
                // Rotation changes picture coordinates. End old contacts rather
                // than keeping stale points until a finger next moves.
                self.clear_touches();
            }
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

impl MetalView {
    fn clear_touches(&self) {
        self.touches().borrow_mut().clear();
        SESSION.with_borrow_mut(|s| {
            if let Some(s) = s {
                s.touches(&[]);
            }
        });
    }
    fn update_touches(&self, changed: &NSSet<UITouch>, phase: u8) {
        if !ACTIVE.with(|a| a.get()) {
            self.clear_touches();
            return;
        }
        let aspect = SESSION.with_borrow(|s| s.as_ref().and_then(|s| s.picture_aspect()));
        let bounds = self.bounds();
        let snapshot = {
            let mut fingers = self.touches().borrow_mut();
            for touch in changed {
                // Identity only, never dereferenced; UIKit preserves each UITouch
                // identity for its gesture. End/cancel/lifecycle removes it.
                let key = Retained::as_ptr(&touch) as usize;
                if phase == 2 {
                    fingers.end(key);
                    continue;
                }
                let point = touch.locationInView(Some(self));
                let point = normalize(
                    point.x - bounds.origin.x,
                    point.y - bounds.origin.y,
                    bounds.size.width,
                    bounds.size.height,
                    aspect,
                    phase == 1,
                );
                if phase == 0 {
                    fingers.begin(key, point);
                } else {
                    fingers.moved(key, point);
                }
            }
            fingers.snapshot()
        };
        // Drop the ivar borrow before calling arbitrary session code.
        SESSION.with_borrow_mut(|s| {
            if let Some(s) = s {
                s.touches(&snapshot);
            }
        });
    }
}

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
            view.setMultipleTouchEnabled(true);
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
                let maximum_fps = u32::try_from(scene.screen().maximumFramesPerSecond()).unwrap_or(60);
                let session = factory(layer, paths, maximum_fps)?;
                SESSION.with_borrow_mut(|s| *s = Some(session));
                view.setNeedsLayout();
                Ok::<(), String>(())
            })();
            if let Err(error) = result { show_error(&controller, &error, mtm); }
        }
        #[unsafe(method(sceneDidBecomeActive:))]
        fn became_active(&self, _scene: &UIScene) { active(true); }
        #[unsafe(method(sceneWillResignActive:))]
        fn resigned_active(&self, _scene: &UIScene) { self.clear_touches(); active(false); }
        #[unsafe(method(sceneDidDisconnect:))]
        fn disconnected(&self, _scene: &UIScene) { self.clear_touches(); stop(); self.window().borrow_mut().take(); }
    }
);

impl SceneDelegate {
    fn clear_touches(&self) {
        if let Some(window) = self.window().borrow().as_ref() {
            if let Some(controller) = window.rootViewController() {
                if let Some(view) = controller.view()
                    && let Some(view) = view.downcast_ref::<MetalView>()
                {
                    view.clear_touches();
                }
            }
        }
    }
}

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
