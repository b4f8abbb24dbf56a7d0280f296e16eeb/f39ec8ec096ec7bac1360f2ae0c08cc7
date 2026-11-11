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
boundary](https://github.com/LNPANDY/NX2Apple/tree/main/frontend-ios). This shell
is implemented for nxkit's existing runtime; no NX2Apple code, nxnative loader,
per-game framework isolation or teardown implementation is copied.
