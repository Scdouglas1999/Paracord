pub mod admission;
pub mod connection;
pub mod control;
pub mod endpoint;
pub mod federation;
pub mod file_transfer;
pub mod protocol;
pub mod stream;
pub mod webtransport;

use std::sync::OnceLock;

/// Ensure a process-wide rustls crypto provider is installed.
///
/// rustls 0.23 requires selecting a provider explicitly when multiple providers
/// may be present in the dependency graph.
pub(crate) fn ensure_rustls_provider() {
    static RUSTLS_PROVIDER_INIT: OnceLock<()> = OnceLock::new();
    RUSTLS_PROVIDER_INIT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
