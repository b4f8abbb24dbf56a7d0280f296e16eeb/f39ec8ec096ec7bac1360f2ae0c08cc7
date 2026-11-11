# Swift app shell

`App.swift` owns UIApplication, the single UIWindowScene, startup errors and
foreground/background/disconnect handling. `MetalView.swift` owns the real
CAMetalLayer drawable size and UIKit touch routing. `TouchState.swift` has no
UIKit dependency and is tested on the CI Mac before the app links.

The Rust static library exposes only the C functions in
`ios/app/include/nx2ipa.h`. Calls stay on the main thread; strings, buffers and
touch arrays are borrowed only during each call. Rust retains the Metal layer
and owns the runtime session. No Rust object or allocator ownership crosses C.
The shell never loads a guest dylib or implements kernel/GPU services itself.

Only one game may initialize per process. Disconnect pauses input/audio/rendering
and requests process shutdown; it is not a library navigation/reset flow. The
session and guest mappings are kept alive until process exit because the shared
kernel has process-lifetime state and detached guest threads.

Touches have stable IDs in 0..<16 and normalized picture coordinates. The current
presenter fills the drawable, so touches map to the actual full view without an
assumed 16:9 rectangle. Aspect-fit mapping is available only if the native
presenter reports that it actually uses it. New touches in bars are rejected;
existing drags clamp to the edge. Rotation, inactivity and cancellation release
contacts. These portable tests do not establish physical device input delivery.

The useful architectural reference was [NX2Apple's Swift shell and engine
boundary](https://github.com/LNPANDY/NX2Apple/tree/main/frontend-ios). The scene shell is implemented for nxkit's runtime. The overlay adaptation below
reuses NX2Apple code, but no nxnative loader, per-game framework isolation or
library-return teardown implementation is copied.

## Single-game overlay

The gameplay overlay now adapts NX2Apple's real `DmGamepad.m` and
`DmPadGeometry.h` at the revisions recorded in `overlay/SOURCE.json`. It keeps
its shapes, positions, touch ownership, dead zone, eight-way D-pad and floating
right-stick behavior. The menu is an adapted `GameMenu.swift`, not a new gamepad
design. Full MIT notices are in `overlay/LICENSE` and bundled into generated apps.

The gear offers 2D, 3D and (in handheld mode) Tap, three control sizes, three
left-stick placements, keys that toggle, touch feedback, and confirmed Quit.
Choices persist in this single-game app's defaults. The free-form layout editor,
phone-motion implementation, controller applets, TV/split-screen rendering,
launcher-only settings and controller-Home quit gesture are not ported.
Physical controllers, rumble and motion continue through nxkit, with no second
set of GameController handlers. A real physical controller hides the virtual
pad; a disconnect restores it after at most the 150 ms enumeration recheck.

`nx2ipa_virtual_pad` sends a complete P1 snapshot through a small explicit Rust
adapter. The existing nxkit Npad builder still produces guest input. Buttons
combine with physical P1, and each stick axis uses the stronger magnitude.
Unknown bits and nonfinite axes are sanitized. Focus loss, rotation, safe-area
changes, menu opening, layout changes, controller changes, cancellation and Quit
release controls and guest touches. UIKit does not own guest memory or threads.
Quit uses the existing process-stop watchdog, which can take up to five seconds;
a closing message covers that interval. It does not return to a game library.

The source geometry and hit-test harness runs as portable C with test-only
CoreGraphics value types: `bun tests/native-build.mjs` covers 14 screen shapes
and 10,080 arrangements. This does not exercise UIKit, multitouch delivery or
menu animation. The Rust input/host/app tests and an iOS-target Rust check are
separate gates. The final Swift/Objective-C SDK compile/link, gesture/lifecycle
interaction tests and physical-device gameplay remain required. No source-only
check produces a new host IPA or upgrades an already embedded binary.
