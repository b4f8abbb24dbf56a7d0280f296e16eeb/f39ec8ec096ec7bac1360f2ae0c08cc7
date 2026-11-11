# iOS system boundary

Only `sys.rs` is replaced by `platform.rs`; all other pinned system-service modules
remain unchanged. The libc crate provides Darwin's `CLOCK_MONOTONIC` (6 on iOS),
`timespec`, and `tm` layouts instead of choosing Linux's clock number on iOS.
Calendar conversion and native guest-call entry points preserve the shared service
API. Null guest function addresses are rejected before conversion to a function.

Linux tests cover advancing time and UTC/local calendar round trips. The iOS
cross-target check compiles the Darwin ABI; actual iOS clock behavior still needs
an on-device run.
