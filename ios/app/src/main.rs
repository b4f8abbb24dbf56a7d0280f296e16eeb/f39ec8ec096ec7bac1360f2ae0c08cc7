//! Rust UIKit entry point for the bundled, process-lifetime native game runtime.
#[cfg(target_os = "ios")]
fn main() {
    if let Err(error) = nx2ipa_ios_shell::run(nxkit_host::session::start) {
        eprintln!("nx2ipa: {error}");
        std::process::exit(1);
    }
}
#[cfg(not(target_os = "ios"))]
fn main() {
    eprintln!("nx2ipa requires a physical arm64 iOS target");
}
