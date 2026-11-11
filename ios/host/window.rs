//! Compatibility event vocabulary for the shared input seams. No AppKit is linked.
//! UIKit lifecycle and touch handling live in the separate shell.
#[derive(Debug, Clone, Copy)]
pub enum MouseEvent {
    Moved { dx: f64, dy: f64 },
    Button { number: u8, down: bool },
    Wheel { dy: f64 },
    Released,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseMode {
    Off,
    Click,
    Auto,
}
