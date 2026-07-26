#![allow(clippy::too_many_arguments)]

pub mod bandwidth;
pub mod e2ee;
pub mod federation;
pub mod p2p;
pub mod participant;
pub mod relay;
pub mod room;
pub mod signaling;
pub mod speaker;
pub mod stream;

/// Regression tests for the resource bounds that keep one media peer from
/// exhausting a modest self-hosted server. Kept in its own file so the bounds
/// are reviewable as a group rather than scattered through each module's tests.
#[cfg(test)]
mod availability_bounds_tests;
