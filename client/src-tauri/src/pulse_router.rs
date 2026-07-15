//! Linux stream-capture audio routing.
//!
//! Capturing `@DEFAULT_MONITOR@` records everything the default sink plays —
//! including Paracord's own voice-chat playback, which viewers then hear as a
//! delayed echo of themselves. There is no PulseAudio/PipeWire API to exclude
//! one client from a monitor source, so this module takes the approach used by
//! venmic/Vesktop, driven through `pactl` (works on both PulseAudio and
//! pipewire-pulse):
//!
//! 1. Load a private null sink (`paracord_stream_capture`).
//! 2. Load a `module-loopback` from that sink's monitor to the user's default
//!    sink, so the user keeps hearing everything normally.
//! 3. Move every application's playback stream into the null sink — EXCEPT
//!    Paracord's own streams and the loopback itself — and keep watching for
//!    newly started applications while the capture session runs.
//! 4. Capture the null sink's monitor: it contains all system audio except
//!    Paracord, so voice chat can never feed back into the stream.
//!
//! Everything is restored on stop; stale modules from a crashed session are
//! unloaded on the next start.
//!
//! ## Hard requirement — no `@DEFAULT_MONITOR@` fallback
//!
//! Echo-free routing is MANDATORY. If `pactl` (or its JSON output) is
//! unavailable, [`PulseStreamRouter::setup`] returns an `Err` and the caller
//! (`audio_capture.rs`) refuses to start system-audio capture — it does NOT
//! fall back to capturing `@DEFAULT_MONITOR@`. A silent fallback would loop
//! every remote participant's voice back into the stream (echoing them to
//! themselves), which is strictly worse than surfacing that system audio is
//! unavailable. Fail loudly, never degrade.
#![cfg(target_os = "linux")]

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

pub const CAPTURE_SINK_NAME: &str = "paracord_stream_capture";
pub const CAPTURE_SOURCE_NAME: &str = "paracord_stream_capture.monitor";
/// Extra latency the loopback adds to what the user hears from other apps
/// while streaming. Low enough to be unnoticeable, high enough to be stable.
const LOOPBACK_LATENCY_MS: u32 = 40;

/// Tight watchdog cadence covering the window in which WirePlumber's
/// asynchronous default-node rescan can auto-switch the default output onto
/// the freshly created capture sink. That rescan lands tens to hundreds of
/// milliseconds after the sink/loopback appear — i.e. *after* `setup()`'s
/// single immediate check — so a one-shot restore misses it and the wrong
/// device stays selected until the next 1s sweep. We instead re-assert the
/// default every `WATCHDOG_INTERVAL_MS` for `WATCHDOG_ITERATIONS`
/// (≈30 × 100ms ≈ 3s), after which the ordinary 1s session sweep takes over.
const WATCHDOG_ITERATIONS: u32 = 30;
const WATCHDOG_INTERVAL_MS: u64 = 100;
/// Within the watchdog window, still run the full app sweep on the normal ~1s
/// cadence (every N tight iterations) so applications started mid-setup are
/// routed into the capture sink without waiting for the watchdog to finish.
const WATCHDOG_ITERATIONS_PER_SWEEP: u32 = (1000 / WATCHDOG_INTERVAL_MS) as u32;

pub struct PulseStreamRouter {
    sink_module: u64,
    loopback_module: u64,
    /// The user's real default sink at setup time. The loopback is pinned to
    /// this concrete name (never `@DEFAULT_SINK@`, which can re-resolve to the
    /// capture sink itself and feed back), and the session default is forced
    /// back to it whenever the sound server auto-switches the default onto
    /// the newly created capture sink.
    real_default_sink: String,
    /// sink-input index → original sink name, for restoration on stop.
    moved: HashMap<u64, String>,
    /// sink-inputs that refused to move on the *previous* sweep (e.g. a stream
    /// that was momentarily DONT_MOVE). Retained only to suppress duplicate log
    /// spam: every sweep still re-attempts them, because a stream can become
    /// movable later (AU11c).
    skipped: HashSet<u64>,
}

fn pactl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("pactl")
        .args(args)
        .output()
        .map_err(|e| format!("pactl unavailable: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "pactl {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn pactl_json(what: &str) -> Result<serde_json::Value, String> {
    let out = pactl(&["-f", "json", "list", what])?;
    serde_json::from_str(&out).map_err(|e| format!("pactl -f json list {what}: {e}"))
}

/// pactl's JSON encodes some numbers as strings depending on version; accept
/// either form.
fn as_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

impl PulseStreamRouter {
    /// Load the capture sink + loopback and perform the initial stream sweep.
    pub fn setup() -> Result<Self, String> {
        Self::unload_stale_modules();

        // Resolve the user's actual output device BEFORE creating anything.
        // Everything downstream is pinned to this concrete name: sound servers
        // (WirePlumber in particular) can auto-switch the default sink to a
        // newly created device, and if the loopback targeted `@DEFAULT_SINK@`
        // it could resolve to the capture sink itself — a feedback loop that
        // silences all audio.
        let real_default_sink = pactl(&["get-default-sink"])?.trim().to_string();
        if real_default_sink.is_empty() || real_default_sink == CAPTURE_SINK_NAME {
            return Err(format!(
                "could not resolve the real default sink (got {real_default_sink:?})"
            ));
        }

        // `priority.session=0` pins the capture sink to the lowest default-node
        // ranking. WirePlumber's default-node policy (0.5.x) is purely
        // priority-based — there is NO boolean "hide from default" flag
        // (empirically, node.hidden / node.dont-reconnect / node.passive do not
        // exclude a node from selection). A real output device sits at ~1000+
        // and the user's configured default gets a +30000 election boost, so a
        // priority-0 null sink can never out-rank them and be auto-selected
        // while any real sink exists. The watchdog below covers the residual
        // transient where the null sink is momentarily the only live candidate.
        let sink_module = pactl(&[
            "load-module",
            "module-null-sink",
            &format!("sink_name={CAPTURE_SINK_NAME}"),
            "rate=48000",
            "channels=2",
            "sink_properties=device.description=Paracord-Stream-Capture priority.session=0",
        ])?
        .trim()
        .parse::<u64>()
        .map_err(|e| format!("unexpected module-null-sink id: {e}"))?;

        // If the sound server just made our capture sink the default output,
        // put the user's device back before anything routes to it.
        Self::restore_default_sink(&real_default_sink);

        let loopback_module = match pactl(&[
            "load-module",
            "module-loopback",
            &format!("source={CAPTURE_SOURCE_NAME}"),
            &format!("sink={real_default_sink}"),
            &format!("latency_msec={LOOPBACK_LATENCY_MS}"),
        ]) {
            Ok(out) => match out.trim().parse::<u64>() {
                Ok(id) => id,
                Err(e) => {
                    let _ = pactl(&["unload-module", &sink_module.to_string()]);
                    Self::restore_default_sink(&real_default_sink);
                    return Err(format!("unexpected module-loopback id: {e}"));
                }
            },
            Err(e) => {
                let _ = pactl(&["unload-module", &sink_module.to_string()]);
                Self::restore_default_sink(&real_default_sink);
                return Err(e);
            }
        };

        let mut router = Self {
            sink_module,
            loopback_module,
            real_default_sink,
            moved: HashMap::new(),
            skipped: HashSet::new(),
        };
        router.sync();
        Ok(router)
    }

    /// If the default sink has been switched onto the capture sink (sound
    /// servers auto-switch to new devices; users can also click it in a
    /// device list), put the user's real device back. Any other default the
    /// user picks is respected.
    fn restore_default_sink(real_default_sink: &str) {
        match pactl(&["get-default-sink"]) {
            Ok(current) if current.trim() == CAPTURE_SINK_NAME => {
                eprintln!(
                    "[pulse_router] default sink switched to the capture sink; \
                     restoring {real_default_sink}"
                );
                let _ = pactl(&["set-default-sink", real_default_sink]);
            }
            _ => {}
        }
    }

    /// Tight guard against WirePlumber's *asynchronous* default-node
    /// auto-switch. The sound server re-evaluates default nodes after our
    /// capture sink and loopback appear, and that rescan can land well after
    /// `setup()`'s single immediate `restore_default_sink` — leaving the user
    /// visibly on the wrong output device until the next 1s sweep. This runs in
    /// the router thread (capture starts in parallel; it does NOT block start)
    /// and, every `WATCHDOG_INTERVAL_MS` for `WATCHDOG_ITERATIONS`:
    ///   (a) restores the default sink if it was switched onto the capture sink;
    ///   (b) rescues any of Paracord's own playback streams that followed that
    ///       switch onto the capture sink (`linking.follow-default-target`).
    /// It also keeps the normal ~1s app sweep running so nothing regresses, then
    /// returns so the existing 1s session sweep continues. Aborts early if the
    /// session is stopping.
    pub fn watchdog(&mut self, stop: &AtomicBool) {
        for i in 0..WATCHDOG_ITERATIONS {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            Self::restore_default_sink(&self.real_default_sink);
            self.rescue_own_sink_inputs();
            // On each ~1s boundary, run the full sweep too, so applications
            // that started mid-setup are moved into the capture sink on the
            // usual cadence rather than only once the watchdog finishes.
            if i > 0 && i % WATCHDOG_ITERATIONS_PER_SWEEP == 0 {
                self.sync();
            }
            thread::sleep(Duration::from_millis(WATCHDOG_INTERVAL_MS));
        }
    }

    /// Move any of Paracord's own playback streams that have landed on the
    /// capture sink back to the user's real device. When the sound server
    /// switches the default onto the capture sink, streams that follow the
    /// default get dragged onto it; our own playback must never sit there — it
    /// would be inaudible AND would loop voice chat back into the stream.
    fn rescue_own_sink_inputs(&self) {
        let Ok(sinks) = pactl_json("sinks") else {
            return;
        };
        let Some(capture_index) = Self::find_capture_sink_index(&sinks) else {
            return;
        };
        let Ok(inputs) = pactl_json("sink-inputs") else {
            return;
        };
        let own_pid = std::process::id().to_string();
        for input in inputs.as_array().into_iter().flatten() {
            if input.get("sink").and_then(as_u64) != Some(capture_index) {
                continue;
            }
            if !Self::input_is_own(input, &own_pid) {
                continue;
            }
            if let Some(index) = input.get("index").and_then(as_u64) {
                let _ = pactl(&[
                    "move-sink-input",
                    &index.to_string(),
                    &self.real_default_sink,
                ]);
            }
        }
    }

    /// Locate the capture sink's current index in a `pactl list sinks` JSON
    /// value (its numeric index changes across load/unload cycles).
    fn find_capture_sink_index(sinks: &serde_json::Value) -> Option<u64> {
        sinks.as_array().into_iter().flatten().find_map(|sink| {
            (sink.get("name").and_then(|n| n.as_str()) == Some(CAPTURE_SINK_NAME))
                .then(|| sink.get("index").and_then(as_u64))
                .flatten()
        })
    }

    /// Whether a sink-input belongs to Paracord, by process id or application
    /// name. Our own streams must never be moved onto (and are rescued off) the
    /// capture sink.
    fn input_is_own(input: &serde_json::Value, own_pid: &str) -> bool {
        let properties = input.get("properties");
        let process_id = properties
            .and_then(|p| p.get("application.process.id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let app_name = properties
            .and_then(|p| p.get("application.name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        process_id == own_pid || app_name.to_ascii_lowercase().contains("paracord")
    }

    /// Whether this sink-input is sound-server plumbing rather than an
    /// application's playback. Filter-chain outputs (EasyEffects, custom
    /// PipeWire filters, etc.) appear as sink-inputs but moving them into the
    /// capture sink creates a routing cycle and can strand output on the wrong
    /// hardware device after capture stops.
    fn input_is_routing_infrastructure(input: &serde_json::Value) -> bool {
        let Some(properties) = input.get("properties") else {
            return false;
        };
        let has_application_identity = properties
            .get("application.name")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.is_empty())
            || properties
                .get("application.process.id")
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty());
        if has_application_identity {
            return false;
        }

        ["node.virtual", "node.passive"].iter().any(|key| {
            properties.get(*key).is_some_and(|value| {
                value.as_bool() == Some(true)
                    || value
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case("true") || value == "1")
            })
        })
    }

    /// A virtual routing node may declare the concrete sink it feeds. Prefer
    /// that target when recovering plumbing from the capture sink, rather than
    /// sending it to the logical default (which may be the filter's own input).
    fn routing_target(
        input: &serde_json::Value,
        sink_names: &HashMap<u64, String>,
    ) -> Option<String> {
        let target = input
            .get("properties")
            .and_then(|properties| properties.get("node.target"))
            .and_then(|value| value.as_str())?;
        sink_names
            .values()
            .any(|name| name == target)
            .then(|| target.to_string())
    }

    /// Move any playback stream that is not ours (and not the loopback) into
    /// the capture sink. Called periodically so applications started
    /// mid-stream are picked up.
    pub fn sync(&mut self) {
        Self::restore_default_sink(&self.real_default_sink);
        let sinks = match pactl_json("sinks") {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[pulse_router] sink enumeration failed: {err}");
                return;
            }
        };
        let mut sink_names: HashMap<u64, String> = HashMap::new();
        let mut capture_sink_index: Option<u64> = None;
        for sink in sinks.as_array().into_iter().flatten() {
            let (Some(index), Some(name)) = (
                sink.get("index").and_then(as_u64),
                sink.get("name").and_then(|n| n.as_str()),
            ) else {
                continue;
            };
            if name == CAPTURE_SINK_NAME {
                capture_sink_index = Some(index);
            }
            sink_names.insert(index, name.to_string());
        }
        let Some(capture_sink_index) = capture_sink_index else {
            eprintln!("[pulse_router] capture sink disappeared; skipping sweep");
            return;
        };

        let inputs = match pactl_json("sink-inputs") {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[pulse_router] sink-input enumeration failed: {err}");
                return;
            }
        };
        // Retry everything each sweep (AU11c): a stream that refused to move
        // before (transient DONT_MOVE) may be movable now. The previous sweep's
        // skip set is kept only to avoid re-logging the same failure every 1s.
        let previously_skipped = std::mem::take(&mut self.skipped);
        let own_pid = std::process::id().to_string();
        for input in inputs.as_array().into_iter().flatten() {
            let Some(index) = input.get("index").and_then(as_u64) else {
                continue;
            };
            // The loopback's own playback into the default sink must never be
            // routed back into the sink it reads from (feedback loop).
            if input.get("owner_module").and_then(as_u64) == Some(self.loopback_module) {
                continue;
            }
            let current_sink = input.get("sink").and_then(as_u64);
            if Self::input_is_own(input, &own_pid) {
                // Our own playback must NEVER sit on the capture sink — it
                // would be inaudible AND loop voice chat into the stream
                // (e.g. after a default-sink switch dragged it there). Send
                // it back to the user's real device.
                if current_sink == Some(capture_sink_index) {
                    let _ = pactl(&[
                        "move-sink-input",
                        &index.to_string(),
                        &self.real_default_sink,
                    ]);
                }
                continue;
            }
            if Self::input_is_routing_infrastructure(input) {
                // Older builds may already have parked this filter/loopback on
                // the capture sink. Repair it using its concrete node.target
                // (or its recorded origin) before excluding it from sweeps.
                if current_sink == Some(capture_sink_index) {
                    let destination = Self::routing_target(input, &sink_names)
                        .or_else(|| self.moved.get(&index).cloned());
                    if let Some(destination) = destination {
                        let _ = pactl(&["move-sink-input", &index.to_string(), &destination]);
                        self.moved.remove(&index);
                    }
                }
                continue;
            }
            if current_sink == Some(capture_sink_index) {
                continue;
            }

            let original_sink = current_sink
                .and_then(|idx| sink_names.get(&idx).cloned())
                .unwrap_or_else(|| "@DEFAULT_SINK@".to_string());
            match pactl(&["move-sink-input", &index.to_string(), CAPTURE_SINK_NAME]) {
                Ok(_) => {
                    self.moved.entry(index).or_insert(original_sink);
                }
                Err(err) => {
                    // Retry next sweep; only log the first time to avoid spam.
                    if !previously_skipped.contains(&index) {
                        eprintln!("[pulse_router] could not move sink-input {index}: {err}");
                    }
                    self.skipped.insert(index);
                }
            }
        }
    }

    /// Move streams back to where they were and unload our modules.
    pub fn restore(self) {
        for (index, original_sink) in &self.moved {
            // The stream or its original sink may be gone; PulseAudio also
            // rescues streams itself when the null sink unloads below.
            let _ = pactl(&["move-sink-input", &index.to_string(), original_sink]);
        }
        // Sweep anything still parked on the capture sink (streams we never
        // recorded an origin for, or ones the server's stream-restore database
        // re-pinned mid-session) back to the default sink explicitly, so no
        // application is left pointing at a sink that is about to vanish.
        if let Ok(inputs) = pactl_json("sink-inputs") {
            let sinks = pactl_json("sinks").ok();
            let capture_index = sinks.as_ref().and_then(Self::find_capture_sink_index);
            let sink_names: HashMap<u64, String> = sinks
                .as_ref()
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|sink| {
                    Some((
                        sink.get("index").and_then(as_u64)?,
                        sink.get("name")
                            .and_then(|value| value.as_str())?
                            .to_string(),
                    ))
                })
                .collect();
            if let Some(capture_index) = capture_index {
                for input in inputs.as_array().into_iter().flatten() {
                    if input.get("sink").and_then(as_u64) != Some(capture_index) {
                        continue;
                    }
                    if let Some(index) = input.get("index").and_then(as_u64) {
                        let destination = Self::routing_target(input, &sink_names)
                            .unwrap_or_else(|| self.real_default_sink.clone());
                        let _ = pactl(&["move-sink-input", &index.to_string(), &destination]);
                    }
                }
            }
        }
        let _ = pactl(&["unload-module", &self.loopback_module.to_string()]);
        let _ = pactl(&["unload-module", &self.sink_module.to_string()]);
        // Unloading can shuffle the default again; leave the user on their
        // real device.
        Self::restore_default_sink(&self.real_default_sink);
    }

    /// Unload leftovers from a session that did not shut down cleanly. Streams
    /// parked on the vanishing null sink are rescued to the default sink by
    /// the sound server.
    fn unload_stale_modules() {
        let Ok(modules) = pactl_json("modules") else {
            return;
        };
        for module in modules.as_array().into_iter().flatten() {
            let argument = module
                .get("argument")
                .and_then(|a| a.as_str())
                .unwrap_or("");
            if !argument.contains(CAPTURE_SINK_NAME) {
                continue;
            }
            if let Some(index) = module.get("index").and_then(as_u64) {
                eprintln!("[pulse_router] unloading stale module {index}");
                let _ = pactl(&["unload-module", &index.to_string()]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PulseStreamRouter;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn identifies_virtual_filter_output_as_routing_infrastructure() {
        let input = json!({
            "properties": {
                "node.name": "effect_output.odyssey_g95sc_tuned",
                "node.virtual": "true",
                "node.passive": "true",
                "node.target": "alsa_output.hdmi"
            }
        });

        assert!(PulseStreamRouter::input_is_routing_infrastructure(&input));
    }

    #[test]
    fn keeps_identified_application_playback_eligible_for_capture() {
        let input = json!({
            "properties": {
                "application.name": "Example Game",
                "application.process.id": "1234",
                "node.virtual": "true"
            }
        });

        assert!(!PulseStreamRouter::input_is_routing_infrastructure(&input));
    }

    #[test]
    fn resolves_virtual_node_target_only_when_sink_exists() {
        let input = json!({"properties": {"node.target": "alsa_output.hdmi"}});
        let sinks = HashMap::from([(7, "alsa_output.hdmi".to_string())]);

        assert_eq!(
            PulseStreamRouter::routing_target(&input, &sinks).as_deref(),
            Some("alsa_output.hdmi")
        );
        assert_eq!(
            PulseStreamRouter::routing_target(&input, &HashMap::new()),
            None
        );
    }
}
