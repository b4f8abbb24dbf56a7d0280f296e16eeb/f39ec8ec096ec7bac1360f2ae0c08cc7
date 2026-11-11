//! SDK link test only. No game loader or runtime is supplied by this example.
#[cfg(target_os = "ios")]
fn main() {
    // Retain actual input/audio service entry points so the linker verifies their
    // Apple framework references as well as the UIKit shell. No guest is run.
    std::hint::black_box(nxkit_svc_input::exports());
    std::hint::black_box(nxkit_svc_audio::exports());
    if let Err(error) = nx2ipa_ios_shell::run(|_, _, _| {
        Err("Native adapter link probe only. No game runtime is linked.".into())
    }) {
        eprintln!("{error}");
    }
}
#[cfg(not(target_os = "ios"))]
fn main() {
    eprintln!("The native adapter link probe requires an iOS target.");
}
