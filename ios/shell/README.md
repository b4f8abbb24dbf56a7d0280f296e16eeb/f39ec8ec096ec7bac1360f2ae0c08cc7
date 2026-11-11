# Rust UIKit shell

The session factory receives the retained CAMetalLayer, sandbox paths, and the
connected scene screen's maximum frames per second. That maximum is a ceiling,
not proof of adaptive refresh or a measured delivery rate.

The session's `touches` callback receives the complete active set with stable
IDs 0–15 and normalized top-left picture coordinates. UIKit began/moved/ended/
cancelled callbacks run on the main thread. Contacts are released on scene
resignation/disconnection, process termination and view geometry changes. Extra
contacts beyond 16 are ignored until their next independent touch begins.

The pinned GPU presenter (`nxkit-gpu/src/blit.rs`) fills its drawable with a
full-screen triangle; it does not publish an aspect-fit rectangle. The default
mapping therefore uses the actual full Metal view, matching that output.
`Session::picture_aspect` may return an aspect only if the backend really draws
centered aspect-fit content. Then new contacts in bars are rejected and ongoing
drags clamp to picture edges. This API does not itself change GPU rendering or
silently assume every game is 16:9.

Six portable shell tests pass, including four touch identity/geometry tests.
The shell and link-probe target type-check for aarch64-apple-ios. UIKit event
routing, multi-finger gestures and lifecycle behavior still need device testing;
portable tests and Rust checks are not evidence of delivered physical input.
