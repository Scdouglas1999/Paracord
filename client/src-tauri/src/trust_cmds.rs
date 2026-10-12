//! Server identity decisions the first run and the identity-changed sheet make
//! (docs/setup-spec.md §7.3, §7.4, §9.5).
//!
//! The verifier, the pins and the identity-change records live beside the rest
//! of the native trust code in `lib.rs`; these commands are the only ways the
//! renderer can change a pin:
//!
//! - `trust_server(url, fingerprint)`: the invite card or the sign-in trust row
//!   showed the person a server's words and they continued. Pins (and approves
//!   the origin) only if the server presents that same certificate now.
//! - `accept_changed_identity(host, presented_fp)`: "Trust the new identity" in
//!   the identity-changed sheet. Re-pins only to the change the verifier
//!   recorded.
//! - `pending_identity_change(host)`: the recorded change, for a renderer that
//!   was not listening when `trust://identity-changed` was emitted (a reload).
//!
//! Arguments use Tauri's default camelCase on the JS side
//! (`invoke('accept_changed_identity', { host, presentedFp })`).

use crate::{
    clear_observed_fingerprint, clear_pin_mismatch, commit_trusted_origin, decode_fingerprint_hex,
    forget_public_chain, health_body_identifies_paracord, is_loopback_host,
    is_user_approved_server_origin, observe_server, persist_pinned_certs,
    persist_user_approved_origins, pin_host_from_url, pinned_fingerprint,
    record_user_approved_server_origin, recorded_pin_mismatch, remove_pinned_fingerprint,
    remove_user_approved_server_origin, set_pinned_fingerprint, trusted_origin_from_url,
    IdentityChange, PinMismatch, PresentedIdentity, TRUST_EVENT_APP, TRUST_SYNC_LOCK,
};

/// What `trust_server` says when the certificate changed between the card and
/// the click (spec §7.3).
pub(crate) const CHANGED_WHILE_LOOKING: &str =
    "This server's identity changed while you were looking at it.";

/// What `accept_changed_identity` says when the server moved on to yet another
/// certificate after the sheet was drawn.
pub(crate) const CHANGED_AGAIN: &str =
    "This server's identity changed again while you were looking at it. Review it again before you trust it.";

/// Give the verifier the app to emit `trust://identity-changed` through. Called
/// once from `setup`.
pub(crate) fn remember_app(app: &tauri::AppHandle) {
    let _ = TRUST_EVENT_APP.set(app.clone());
}

/// A fingerprint from the renderer: 64 hex digits, either case.
fn parse_fingerprint(hex: &str) -> Result<[u8; 32], String> {
    decode_fingerprint_hex(&hex.trim().to_ascii_lowercase())
        .ok_or_else(|| "That is not a server fingerprint (64 hex digits).".to_string())
}

/// A host from the renderer, in the form pins are keyed by: lowercase, IPv6
/// without brackets.
fn normalize_host(host: &str) -> Result<String, String> {
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || host.contains('@') || host.contains(' ') {
        return Err("That is not a server host.".to_string());
    }
    Ok(host)
}

/// The person was shown `shown`; the server presents `presented` now.
fn check_shown_identity(shown: [u8; 32], presented: PresentedIdentity) -> Result<(), String> {
    if presented.fingerprint == shown {
        Ok(())
    } else {
        Err(CHANGED_WHILE_LOOKING.to_string())
    }
}

/// The sheet showed `presented`; the verifier recorded `recorded`.
fn check_accept(
    recorded: Option<PinMismatch>,
    host: &str,
    presented: [u8; 32],
) -> Result<(), String> {
    match recorded {
        None => Err(format!("{host} has not shown a new identity.")),
        Some(mismatch) if mismatch.presented == presented => Ok(()),
        Some(_) => Err(CHANGED_AGAIN.to_string()),
    }
}

/// Put back the pin a failed command replaced.
fn restore_pin(host: &str, previous: Option<[u8; 32]>) {
    match previous {
        Some(fp) => set_pinned_fingerprint(host.to_string(), fp),
        None => remove_pinned_fingerprint(host),
    }
}

/// Pins `fingerprint` for `url`'s host, only if it is the fingerprint the
/// server presents right now (spec §7.3), and approves the origin: the card the
/// person just confirmed is the trust decision, so the native "Trust new
/// Paracord instance?" dialog does not ask again for it. A server whose chain a
/// public authority signed is approved without a pin (§7.2).
#[tauri::command]
pub async fn trust_server(
    app: tauri::AppHandle,
    url: String,
    fingerprint: String,
) -> Result<(), String> {
    let shown = parse_fingerprint(&fingerprint)?;
    let parsed = url::Url::parse(&url).map_err(|_| "Server URL must be absolute.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only an https:// server has an identity to trust.".to_string());
    }
    let origin =
        trusted_origin_from_url(&url).ok_or_else(|| "Server URL must be absolute.".to_string())?;
    let host = pin_host_from_url(&url).ok_or_else(|| "Server URL has no host.".to_string())?;

    let _one_decision_at_a_time = TRUST_SYNC_LOCK.lock().await;
    clear_observed_fingerprint(&host);
    let (body, presented) = observe_server(&url).await?;
    clear_observed_fingerprint(&host);
    if !health_body_identifies_paracord(&body) {
        return Err(format!("{origin} did not answer as a Paracord server."));
    }
    let presented =
        presented.ok_or_else(|| format!("{origin} presented no certificate to compare."))?;
    check_shown_identity(shown, presented)?;

    let previous_pin = pinned_fingerprint(&host);
    let pin = !presented.ca_verified && !is_loopback_host(&host);
    let pin_changed = pin && previous_pin != Some(presented.fingerprint);
    if pin_changed {
        set_pinned_fingerprint(host.clone(), presented.fingerprint);
        if let Err(err) = persist_pinned_certs(&app) {
            restore_pin(&host, previous_pin);
            return Err(format!("Could not save this server's identity: {err}"));
        }
    }
    if !is_user_approved_server_origin(&origin) {
        record_user_approved_server_origin(origin.clone())?;
        if let Err(err) = persist_user_approved_origins(&app) {
            remove_user_approved_server_origin(&origin);
            if pin_changed {
                restore_pin(&host, previous_pin);
                if let Err(rollback) = persist_pinned_certs(&app) {
                    eprintln!("failed to roll back the certificate pin of {host}: {rollback}");
                }
            }
            return Err(format!("Could not save this server's identity: {err}"));
        }
    }
    commit_trusted_origin(&origin, true);
    Ok(())
}

/// Re-pins `host` to `presented_fp`, only if that is the recorded mismatch
/// (spec §7.4), and persists it. The renderer then reconnects the server.
#[tauri::command]
pub async fn accept_changed_identity(
    app: tauri::AppHandle,
    host: String,
    presented_fp: String,
) -> Result<(), String> {
    let host = normalize_host(&host)?;
    let presented = parse_fingerprint(&presented_fp)?;

    let _one_decision_at_a_time = TRUST_SYNC_LOCK.lock().await;
    check_accept(recorded_pin_mismatch(&host), &host, presented)?;
    let previous_pin = pinned_fingerprint(&host);
    set_pinned_fingerprint(host.clone(), presented);
    if let Err(err) = persist_pinned_certs(&app) {
        restore_pin(&host, previous_pin);
        return Err(format!("Could not save the new identity: {err}"));
    }
    clear_pin_mismatch(&host);
    forget_public_chain(&host);
    clear_observed_fingerprint(&host);
    Ok(())
}

/// The identity change recorded for `host` this run, if there is one.
#[tauri::command]
pub async fn pending_identity_change(host: String) -> Result<Option<IdentityChange>, String> {
    let host = normalize_host(&host)?;
    Ok(recorded_pin_mismatch(&host).map(|mismatch| IdentityChange::new(&host, mismatch)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        decide_server_cert, public_chain_leaf, sha256_fingerprint, take_observed_fingerprint,
        CertDecision, IdentityObserver, TofuPinningVerifier, PIN_MISMATCH_MESSAGE,
    };
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use std::sync::Arc;

    fn provider() -> Arc<rustls::crypto::CryptoProvider> {
        Arc::new(rustls::crypto::ring::default_provider())
    }

    fn self_signed(name: &str) -> CertificateDer<'static> {
        let key = rcgen::KeyPair::generate().expect("key");
        let params = rcgen::CertificateParams::new(vec![name.to_string()]).expect("params");
        params.self_signed(&key).expect("self-signed").der().clone()
    }

    /// A private CA standing in for the public authorities, and a leaf it signed.
    struct Chain {
        root: CertificateDer<'static>,
        leaf: CertificateDer<'static>,
    }

    fn ca_chain(name: &str) -> Chain {
        let ca_key = rcgen::KeyPair::generate().expect("ca key");
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("ca params");
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
        ];
        ca_params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "Paracord test authority");
        let ca = ca_params.self_signed(&ca_key).expect("ca");
        let leaf_key = rcgen::KeyPair::generate().expect("leaf key");
        let mut leaf_params =
            rcgen::CertificateParams::new(vec![name.to_string()]).expect("leaf params");
        leaf_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let leaf = leaf_params
            .signed_by(&leaf_key, &ca, &ca_key)
            .expect("leaf");
        Chain {
            root: ca.der().clone(),
            leaf: leaf.der().clone(),
        }
    }

    /// The authorities a test verifier trusts: `extra`, or an unrelated CA (a
    /// verifier needs at least one), so no self-signed certificate is public.
    fn roots(extra: Option<&CertificateDer<'static>>) -> rustls::RootCertStore {
        let mut store = rustls::RootCertStore::empty();
        let unrelated;
        let root = match extra {
            Some(root) => root,
            None => {
                unrelated = ca_chain("s10-unrelated.example").root;
                &unrelated
            }
        };
        store.add(root.clone()).expect("test root");
        store
    }

    fn verifier(
        extra_root: Option<&CertificateDer<'static>>,
    ) -> (TofuPinningVerifier, IdentityObserver) {
        let observer = IdentityObserver::default();
        let verifier =
            TofuPinningVerifier::new(provider(), roots(extra_root), Some(observer.clone()))
                .expect("verifier");
        (verifier, observer)
    }

    fn verify(
        verifier: &TofuPinningVerifier,
        host: &str,
        cert: &CertificateDer<'static>,
    ) -> Result<(), rustls::Error> {
        let name = ServerName::try_from(host.to_string()).expect("server name");
        verifier
            .verify_server_cert(cert, &[], &name, &[], UnixTime::now())
            .map(|_| ())
    }

    fn seen(observer: &IdentityObserver) -> Option<PresentedIdentity> {
        *observer.lock().unwrap()
    }

    #[test]
    fn the_order_is_public_chain_then_pin_then_first_use() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        // A public chain wins over a pin that differs (an ACME renewal).
        assert_eq!(
            decide_server_cert(a, true, Some(b), None),
            CertDecision::PublicChain
        );
        assert_eq!(
            decide_server_cert(a, false, Some(a), None),
            CertDecision::Known
        );
        assert_eq!(
            decide_server_cert(a, false, Some(b), None),
            CertDecision::Changed { expected: b }
        );
        assert_eq!(
            decide_server_cert(a, false, None, None),
            CertDecision::FirstUse
        );
        // Public earlier this run, not now: the earlier leaf stands in for a pin.
        assert_eq!(
            decide_server_cert(a, false, None, Some(b)),
            CertDecision::Changed { expected: b }
        );
        assert_eq!(
            decide_server_cert(a, false, None, Some(a)),
            CertDecision::Known
        );
        // A pin outranks the run's public leaf.
        assert_eq!(
            decide_server_cert(a, false, Some(b), Some(a)),
            CertDecision::Changed { expected: b }
        );
    }

    #[test]
    fn loopback_is_accepted_and_observed_without_a_pin() {
        let (verifier, observer) = verifier(None);
        let cert = self_signed("localhost");
        verify(&verifier, "127.0.0.1", &cert).expect("loopback");
        assert_eq!(
            seen(&observer),
            Some(PresentedIdentity {
                fingerprint: sha256_fingerprint(cert.as_ref()),
                ca_verified: false
            })
        );
        assert!(pinned_fingerprint("127.0.0.1").is_none());
    }

    #[test]
    fn a_chain_a_public_authority_signed_is_accepted_and_not_pinned() {
        let host = "s10-public.example";
        let chain = ca_chain(host);
        let (verifier, observer) = verifier(Some(&chain.root));
        verify(&verifier, host, &chain.leaf).expect("public chain");
        let fp = sha256_fingerprint(chain.leaf.as_ref());
        assert_eq!(
            seen(&observer),
            Some(PresentedIdentity {
                fingerprint: fp,
                ca_verified: true
            })
        );
        assert_eq!(public_chain_leaf(host), Some(fp));
        assert!(pinned_fingerprint(host).is_none());
        assert!(
            take_observed_fingerprint(host).is_none(),
            "a public chain is not a first use"
        );
    }

    #[test]
    fn a_public_chain_for_another_name_is_not_public() {
        let chain = ca_chain("s10-other-name.example");
        let (verifier, observer) = verifier(Some(&chain.root));
        let host = "s10-wrong-name.example";
        verify(&verifier, host, &chain.leaf).expect("first use");
        assert_eq!(seen(&observer).map(|s| s.ca_verified), Some(false));
        assert!(public_chain_leaf(host).is_none());
        assert!(take_observed_fingerprint(host).is_some());
    }

    #[test]
    fn the_pinned_certificate_is_accepted() {
        let host = "s10-pinned.example";
        let cert = self_signed(host);
        let fp = sha256_fingerprint(cert.as_ref());
        set_pinned_fingerprint(host.to_string(), fp);
        let (verifier, observer) = verifier(None);
        verify(&verifier, host, &cert).expect("pinned");
        assert_eq!(seen(&observer).map(|s| s.fingerprint), Some(fp));
        assert!(recorded_pin_mismatch(host).is_none());
        remove_pinned_fingerprint(host);
    }

    #[test]
    fn another_certificate_for_a_pinned_host_is_refused_and_recorded_once() {
        let host = "s10-changed.example";
        let old = self_signed(host);
        let new = self_signed(host);
        let old_fp = sha256_fingerprint(old.as_ref());
        let new_fp = sha256_fingerprint(new.as_ref());
        set_pinned_fingerprint(host.to_string(), old_fp);
        let (verifier, observer) = verifier(None);

        let err = verify(&verifier, host, &new).expect_err("mismatch");
        assert!(err.to_string().contains(PIN_MISMATCH_MESSAGE), "{err}");
        assert!(
            seen(&observer).is_none(),
            "nothing is observed for a refused handshake"
        );
        assert_eq!(
            recorded_pin_mismatch(host),
            Some(PinMismatch {
                pinned: old_fp,
                presented: new_fp
            })
        );
        // Announced once per host and presented certificate: a second handshake
        // with the same certificate is recorded but not announced again.
        assert!(!crate::record_pin_mismatch(
            host,
            PinMismatch {
                pinned: old_fp,
                presented: new_fp
            }
        ));
        // The pin itself is untouched.
        assert_eq!(pinned_fingerprint(host), Some(old_fp));
        assert!(take_observed_fingerprint(host).is_none());
        clear_pin_mismatch(host);
        remove_pinned_fingerprint(host);
    }

    #[test]
    fn a_host_public_earlier_this_run_that_turns_self_signed_has_changed() {
        let host = "s10-downgrade.example";
        let chain = ca_chain(host);
        let (public_verifier, _) = verifier(Some(&chain.root));
        verify(&public_verifier, host, &chain.leaf).expect("public chain");

        let impostor = self_signed(host);
        let (verifier, _) = verifier(None);
        let err = verify(&verifier, host, &impostor).expect_err("downgrade");
        assert!(err.to_string().contains(PIN_MISMATCH_MESSAGE), "{err}");
        assert_eq!(
            recorded_pin_mismatch(host),
            Some(PinMismatch {
                pinned: sha256_fingerprint(chain.leaf.as_ref()),
                presented: sha256_fingerprint(impostor.as_ref())
            })
        );
        clear_pin_mismatch(host);
        forget_public_chain(host);
    }

    #[test]
    fn a_host_never_seen_is_a_first_use_and_only_observed() {
        let host = "s10-first.example";
        let cert = self_signed(host);
        let (verifier, observer) = verifier(None);
        verify(&verifier, host, &cert).expect("first use");
        let fp = sha256_fingerprint(cert.as_ref());
        assert_eq!(
            seen(&observer),
            Some(PresentedIdentity {
                fingerprint: fp,
                ca_verified: false
            })
        );
        assert!(
            pinned_fingerprint(host).is_none(),
            "nothing is pinned by a handshake"
        );
        assert_eq!(take_observed_fingerprint(host), Some(fp));
    }

    #[test]
    fn trust_needs_the_certificate_the_person_was_shown() {
        let shown = [7u8; 32];
        assert!(check_shown_identity(
            shown,
            PresentedIdentity {
                fingerprint: shown,
                ca_verified: false
            }
        )
        .is_ok());
        assert_eq!(
            check_shown_identity(
                shown,
                PresentedIdentity {
                    fingerprint: [8u8; 32],
                    ca_verified: true
                }
            ),
            Err(CHANGED_WHILE_LOOKING.to_string())
        );
    }

    #[test]
    fn accepting_needs_the_recorded_change() {
        let mismatch = PinMismatch {
            pinned: [1u8; 32],
            presented: [2u8; 32],
        };
        assert!(check_accept(Some(mismatch), "h.example", [2u8; 32]).is_ok());
        assert_eq!(
            check_accept(Some(mismatch), "h.example", [3u8; 32]),
            Err(CHANGED_AGAIN.to_string())
        );
        assert_eq!(
            check_accept(None, "h.example", [2u8; 32]),
            Err("h.example has not shown a new identity.".to_string())
        );
    }

    #[test]
    fn an_accepted_change_clears_and_a_later_one_is_announced_again() {
        let host = "s10-accept.example";
        let first = PinMismatch {
            pinned: [1u8; 32],
            presented: [2u8; 32],
        };
        assert!(crate::record_pin_mismatch(host, first));
        assert!(!crate::record_pin_mismatch(host, first));
        clear_pin_mismatch(host);
        assert!(recorded_pin_mismatch(host).is_none());
        assert!(crate::record_pin_mismatch(host, first));
        clear_pin_mismatch(host);
    }

    #[test]
    fn renderer_input_is_checked() {
        assert!(parse_fingerprint("zz").is_err());
        assert_eq!(parse_fingerprint(&"AB".repeat(32)), Ok([0xab; 32]));
        assert_eq!(normalize_host("[::1]"), Ok("::1".to_string()));
        assert_eq!(
            normalize_host(" Chat.Example "),
            Ok("chat.example".to_string())
        );
        assert!(normalize_host("evil.example/path").is_err());
        assert!(normalize_host("").is_err());
    }

    #[test]
    fn the_probe_answer_carries_the_certificate() {
        let body = serde_json::json!({ "status": "ok", "service": "paracord", "name": "Kanto" });
        let answer = crate::probe_answer(
            body.clone(),
            Some(PresentedIdentity {
                fingerprint: [0xab; 32],
                ca_verified: true,
            }),
        )
        .expect("answer");
        assert_eq!(answer["fingerprint"], serde_json::json!("ab".repeat(32)));
        assert_eq!(answer["ca_verified"], serde_json::json!(true));
        assert_eq!(answer["name"], serde_json::json!("Kanto"));
        let plain = crate::probe_answer(body, None).expect("answer");
        assert_eq!(plain["fingerprint"], serde_json::Value::Null);
        assert_eq!(plain["ca_verified"], serde_json::json!(false));
        assert!(crate::probe_answer(serde_json::json!([1]), None).is_err());
    }

    #[test]
    fn first_contact_probes_are_https_off_this_machine() {
        assert!(crate::is_first_contact_target(
            "https://chat.example:8443/health"
        ));
        assert!(!crate::is_first_contact_target(
            "https://127.0.0.1:8443/health"
        ));
        assert!(!crate::is_first_contact_target("https://localhost/health"));
        assert!(!crate::is_first_contact_target("https://[::1]:8443/health"));
        assert!(!crate::is_first_contact_target(
            "http://chat.example/health"
        ));
    }

    #[test]
    fn a_refused_request_to_a_changed_host_says_so() {
        let host = "s10-gate.example";
        assert!(crate::record_pin_mismatch(
            host,
            PinMismatch {
                pinned: [1u8; 32],
                presented: [2u8; 32]
            }
        ));
        let err = crate::ensure_native_fetch_target_is_trusted(&format!(
            "https://{host}/api/v1/users/@me"
        ))
        .expect_err("untrusted");
        assert!(err.contains(PIN_MISMATCH_MESSAGE), "{err}");
        clear_pin_mismatch(host);
        let err = crate::ensure_native_fetch_target_is_trusted(&format!(
            "https://{host}/api/v1/users/@me"
        ))
        .expect_err("untrusted");
        assert!(err.contains("not in the trusted server list"), "{err}");
    }
}
