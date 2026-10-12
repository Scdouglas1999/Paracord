//! `paracord-host`: the server the desktop app runs in the background as
//! "Paracord on this computer" (docs/setup-spec.md §2.1, §2.7).
//!
//! It is `main.rs` unchanged. Including that file (rather than a second copy
//! or a library split) keeps one program: every module, `crate::` path and
//! test lives in one place, and a change to the server is a change to the host.
//! What differs is the binary: on Windows it uses the GUI subsystem, so Task
//! Scheduler does not open a console window (its output goes to `--log-file`).
#![cfg_attr(windows, windows_subsystem = "windows")]

include!("../main.rs");
