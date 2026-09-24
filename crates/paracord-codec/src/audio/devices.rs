//! Human-readable audio device enumeration and stable device identity.
//!
//! # Why this module exists
//!
//! cpal is the *stream* layer, not the *device naming* layer. On Linux its host
//! is ALSA, so `cpal::Device::name()` returns an ALSA PCM name — `default`,
//! `sysdefault:CARD=Generic_1`, `front:CARD=USB,DEV=0`,
//! `surround51:CARD=Generic_1,DEV=0`, `hdmi:CARD=NVidia,DEV=3`. Those are PCM
//! *routes*, not devices: one physical card produces half a dozen of them, none
//! of them carries the product name, and the device a person actually wants is
//! frequently missing from the list entirely (a USB interface held open by the
//! sound server never shows up as an ALSA capture PCM).
//!
//! The sound server already knows every device's real name. PipeWire and
//! PulseAudio expose, per node:
//!
//! * a **node name** — `alsa_input.usb-Focusrite_Scarlett_Solo_USB-00.…` —
//!   which is stable across reboots and re-plugs, and
//! * a **description** — `Scarlett Solo USB Direct Scarlett Solo USB` — which is
//!   what every other audio application on the machine displays.
//!
//! So: enumerate through the sound server, display the description, persist the
//! node name, and use cpal only to open the stream.
//!
//! # How a selected device is opened
//!
//! cpal can only open PCMs it enumerated; it has no public constructor for an
//! arbitrary ALSA name, so `pipewire:NODE=<node>` is out of reach. Instead the
//! stream is opened on the sound-server PCM (`pipewire`, else `pulse`, else
//! `default`) with the target node published in the environment
//! (`PIPEWIRE_NODE` for the PipeWire ALSA plugin, `PULSE_SINK` / `PULSE_SOURCE`
//! for the PulseAudio ALSA plugin) for the duration of the open. Both plugins
//! read those at `snd_pcm_open` time and connect the new stream to that node.
//! This routes only *our own* stream: it never changes the system default and
//! never moves anybody else's stream.
//!
//! # Fallback
//!
//! With no sound server reachable (`pactl` missing or refusing), enumeration
//! falls back to raw cpal, collapsed to one entry per card and clearly labeled
//! so the caller can say which layer answered. That is a fallback in *naming*
//! only — the stream path is unchanged — and it is reported, never silent.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::process::Command;
use std::sync::Mutex;

use cpal::traits::{DeviceTrait, HostTrait};

/// Reserved id of the "System default" entry. Selecting it means "follow
/// whatever the OS default is", re-resolved on every open.
pub const SYSTEM_DEFAULT_ID: &str = "@default";

/// Which direction a device list is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Input,
    Output,
}

impl Direction {
    fn pactl_object(self) -> &'static str {
        match self {
            Direction::Input => "sources",
            Direction::Output => "sinks",
        }
    }

    /// Env var the ALSA PulseAudio plugin reads to pick a target node.
    fn pulse_env(self) -> &'static str {
        match self {
            Direction::Input => "PULSE_SOURCE",
            Direction::Output => "PULSE_SINK",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Direction::Input => "microphone",
            Direction::Output => "speaker",
        }
    }
}

/// Which layer answered the enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceBackend {
    /// PipeWire / PulseAudio — real device names, stable node ids.
    SoundServer,
    /// Raw cpal (ALSA / WASAPI / CoreAudio) — the naming fallback.
    Cpal,
}

impl DeviceBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceBackend::SoundServer => "sound-server",
            DeviceBackend::Cpal => "cpal",
        }
    }
}

/// Which group a device belongs to in the picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceGroup {
    /// The system default pseudo-entry — always first.
    SystemDefault,
    /// A real capture or playback device.
    Device,
    /// A loopback of something that is playing (`…​.monitor`). Never a
    /// microphone; belongs to the share-system-audio feature, which has its own
    /// control. Surfaced only in its own labeled group.
    Monitor,
}

/// One row in a device picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioDevice {
    /// Stable identity to persist. The sound-server node name on Linux, the
    /// cpal device name elsewhere, or [`SYSTEM_DEFAULT_ID`].
    pub id: String,
    /// What to show the user.
    pub name: String,
    /// Secondary line (profile, or what "System default" currently resolves
    /// to). Never required to tell two devices apart — [`AudioDevice::name`]
    /// alone is always unique within a list.
    pub detail: Option<String>,
    pub is_default: bool,
    pub group: DeviceGroup,
}

/// The result of enumerating one direction.
#[derive(Debug, Clone)]
pub struct DeviceList {
    pub devices: Vec<AudioDevice>,
    pub backend: DeviceBackend,
    /// Why the sound server was not used, when it was not. Shown to the user —
    /// a degraded list is never silent.
    pub warning: Option<String>,
}

/// Where a selected id resolves to, and how to open it.
#[derive(Debug, Clone)]
pub struct DeviceTarget {
    /// Index into cpal's `input_devices()` / `output_devices()` iterator.
    pub cpal_index: usize,
    /// Sound-server node to pin this stream to, when the sound server answered.
    pub node: Option<String>,
    /// Name to log / show for the device actually opened.
    pub display_name: String,
    /// True when the requested id was gone and the default was used instead.
    /// The caller must say so rather than pretending the request was honored.
    pub fell_back_to_default: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("no {0} available")]
    NoDevice(&'static str),
    #[error("cpal device error: {0}")]
    Cpal(#[from] cpal::DevicesError),
}

// ── Enumeration ─────────────────────────────────────────────────────────────

/// Enumerate devices for one direction, preferring the sound server.
pub fn list_devices(direction: Direction) -> Result<DeviceList, DeviceError> {
    if let Some(list) = list_from_sound_server(direction) {
        return Ok(list);
    }

    let raw = raw_cpal_devices(direction)?;
    let default_name = raw
        .iter()
        .find(|(_, _, is_default)| *is_default)
        .map(|(_, name, _)| name.clone());
    let mut devices = collapse_cpal_devices(&raw);
    devices.insert(
        0,
        system_default_entry(default_name.as_deref().map(friendly_cpal_name)),
    );
    Ok(DeviceList {
        devices,
        backend: DeviceBackend::Cpal,
        warning: Some(
            "No sound server (PipeWire/PulseAudio) answered, so these are raw \
             driver names rather than device names."
                .to_string(),
        ),
    })
}

/// The unmodified cpal enumeration: `(index, name, is_default)`.
///
/// This is what the pickers used to display verbatim. It stays public because
/// it is both the naming fallback and the thing the device-name proof example
/// prints as "before".
pub fn raw_cpal_devices(direction: Direction) -> Result<Vec<(usize, String, bool)>, DeviceError> {
    silence_alsa_probe_errors();
    let host = cpal::default_host();
    let default_name = match direction {
        Direction::Input => host.default_input_device(),
        Direction::Output => host.default_output_device(),
    }
    .and_then(|device| device.name().ok());

    let iter: Box<dyn Iterator<Item = cpal::Device>> = match direction {
        Direction::Input => Box::new(host.input_devices()?),
        Direction::Output => Box::new(host.output_devices()?),
    };

    let mut devices = Vec::new();
    for (index, device) in iter.enumerate() {
        let name = device.name().unwrap_or_else(|_| format!("Device {index}"));
        let is_default = default_name.as_deref() == Some(name.as_str());
        devices.push((index, name, is_default));
    }
    Ok(devices)
}

fn system_default_entry(resolves_to: Option<String>) -> AudioDevice {
    AudioDevice {
        id: SYSTEM_DEFAULT_ID.to_string(),
        name: "System default".to_string(),
        detail: resolves_to.map(|name| format!("Currently: {name}")),
        is_default: true,
        group: DeviceGroup::SystemDefault,
    }
}

// ── Sound-server enumeration (PipeWire / PulseAudio via pactl) ───────────────

/// One node as the sound server describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerNode {
    pub name: String,
    pub description: String,
    /// `device.description` — the card, without its profile.
    pub device_description: Option<String>,
    /// `device.profile.description` — e.g. `Digital Stereo (HDMI)`.
    pub profile_description: Option<String>,
    /// `node.nick` — the short name the server itself computed.
    pub nick: Option<String>,
    pub is_monitor: bool,
}

fn list_from_sound_server(direction: Direction) -> Option<DeviceList> {
    let nodes = query_server_nodes(direction)?;
    let default = query_default_node(direction);
    Some(build_device_list(&nodes, default.as_deref()))
}

/// Build the picker list from sound-server nodes. Pure — unit-tested.
pub fn build_device_list(nodes: &[ServerNode], default_node: Option<&str>) -> DeviceList {
    let mut devices: Vec<AudioDevice> = Vec::with_capacity(nodes.len() + 1);
    let mut default_display: Option<String> = None;

    for node in nodes {
        let (name, detail) = compose_name(node);
        let is_default = default_node == Some(node.name.as_str());
        if is_default {
            default_display = Some(name.clone());
        }
        devices.push(AudioDevice {
            id: node.name.clone(),
            name,
            detail,
            is_default,
            group: if node.is_monitor {
                DeviceGroup::Monitor
            } else {
                DeviceGroup::Device
            },
        });
    }

    uniquify_names(&mut devices);

    // Real devices first (default at their head), monitors last.
    devices.sort_by(|a, b| {
        let rank = |d: &AudioDevice| match (d.group, d.is_default) {
            (DeviceGroup::Monitor, _) => 2,
            (_, true) => 0,
            _ => 1,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    devices.insert(0, system_default_entry(default_display));

    DeviceList {
        devices,
        backend: DeviceBackend::SoundServer,
        warning: None,
    }
}

fn pactl(args: &[&str]) -> Option<String> {
    let output = Command::new("pactl").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn query_server_nodes(direction: Direction) -> Option<Vec<ServerNode>> {
    let raw = pactl(&["-f", "json", "list", direction.pactl_object()])?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let array = value.as_array()?;

    let mut nodes = Vec::with_capacity(array.len());
    for entry in array {
        let Some(name) = entry.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let props = entry.get("properties");
        let prop = |key: &str| -> Option<String> {
            props
                .and_then(|p| p.get(key))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty())
        };
        let description = entry
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or(name)
            .to_string();
        // Pulse reports `monitor_source` on sinks and `monitor_of_sink` on
        // sources; pipewire-pulse spells the absent case as JSON null or the
        // string "". Either way, a source with a monitored sink is a loopback.
        let monitor_of = entry
            .get("monitor_of_sink")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let is_monitor = match direction {
            Direction::Input => {
                monitor_of.is_some()
                    || name.ends_with(".monitor")
                    || prop("device.class").as_deref() == Some("monitor")
            }
            Direction::Output => false,
        };

        nodes.push(ServerNode {
            name: name.to_string(),
            description,
            device_description: prop("device.description"),
            profile_description: prop("device.profile.description"),
            nick: prop("node.nick"),
            is_monitor,
        });
    }

    if nodes.is_empty() {
        return None;
    }
    Some(nodes)
}

fn query_default_node(direction: Direction) -> Option<String> {
    let info = pactl(&["info"])?;
    let key = match direction {
        Direction::Input => "Default Source:",
        Direction::Output => "Default Sink:",
    };
    info.lines()
        .find_map(|line| line.trim().strip_prefix(key))
        .map(|rest| rest.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── Naming ──────────────────────────────────────────────────────────────────

/// Compose `(name, detail)` for one sound-server node.
///
/// The rules, in order, all of them using only strings the sound server itself
/// supplies — nothing is invented:
///
/// 1. `node.nick` wins when it is a genuinely different, shorter handle than
///    the card description (this is what surfaces `Odyssey G95SC` instead of
///    `AD103 High Definition Audio Controller`), with the profile as detail.
/// 2. Otherwise the card description is the name and the profile is the detail.
/// 3. Otherwise the full node description, with repeated word runs collapsed
///    (`Scarlett Solo USB Direct Scarlett Solo USB` → `Scarlett Solo USB
///    Direct`).
pub fn compose_name(node: &ServerNode) -> (String, Option<String>) {
    let full = collapse_repeats(&node.description);

    let card = node.device_description.as_deref().map(collapse_repeats);
    let profile = node.profile_description.as_deref().map(collapse_repeats);
    let nick = node.nick.as_deref().map(collapse_repeats);

    let detail = profile.filter(|p| {
        let p = p.to_lowercase();
        !p.is_empty() && p != card.as_deref().unwrap_or("").to_lowercase()
    });

    // A monitor is named after the thing it is listening to, so it is composed
    // by the same rules and then prefixed — the prefix is what the row means.
    let monitor = |name: String| -> String {
        if node.is_monitor && !name.to_lowercase().starts_with("monitor of") {
            format!("Monitor of {name}")
        } else {
            name
        }
    };

    if let (Some(nick), Some(card)) = (nick.as_deref(), card.as_deref()) {
        let differs = !nick.eq_ignore_ascii_case(card)
            && !card.to_lowercase().contains(&nick.to_lowercase())
            && !nick.to_lowercase().contains(&card.to_lowercase());
        if differs {
            return (
                monitor(nick.to_string()),
                detail.or_else(|| Some(card.to_string())),
            );
        }
    }

    if let Some(card) = card {
        if !card.is_empty() {
            let detail = detail
                .filter(|d| !card.to_lowercase().contains(&d.to_lowercase()))
                .map(|d| strip_run(&d, &card))
                .filter(|d| !d.is_empty());
            return (monitor(card), detail);
        }
    }

    (monitor(full), None)
}

/// Collapse a repeated contiguous run of words.
///
/// PipeWire builds a node description by concatenating the card description and
/// the profile description, which repeats the product name whenever the profile
/// already carries it. Removing only an exact repeated run keeps every word the
/// server chose and never merges two different devices into one string.
pub fn collapse_repeats(value: &str) -> String {
    let words: Vec<&str> = value.split_whitespace().collect();
    if words.len() < 2 {
        return words.join(" ");
    }

    let mut words = words;
    // Longest run first, so `A B C A B C` collapses whole rather than pairwise.
    let mut run = words.len() / 2;
    while run >= 1 {
        let mut i = 0usize;
        while i + run <= words.len() {
            let mut j = i + run;
            while j + run <= words.len() {
                let same = (0..run).all(|k| words[i + k].eq_ignore_ascii_case(words[j + k]));
                if same {
                    words.drain(j..j + run);
                } else {
                    j += 1;
                }
            }
            i += 1;
        }
        run -= 1;
    }
    words.join(" ")
}

/// Remove `needle` from `haystack` when it appears as a contiguous run of
/// whole words. Used to keep a profile line from repeating the device name it
/// already sits under (`Direct Scarlett Solo USB` under `Scarlett Solo USB`
/// becomes `Direct`).
fn strip_run(haystack: &str, needle: &str) -> String {
    let needle: Vec<&str> = needle.split_whitespace().collect();
    if needle.is_empty() {
        return haystack.trim().to_string();
    }
    let mut words: Vec<&str> = haystack.split_whitespace().collect();
    let mut i = 0usize;
    while i + needle.len() <= words.len() {
        let same = (0..needle.len()).all(|k| words[i + k].eq_ignore_ascii_case(needle[k]));
        if same {
            words.drain(i..i + needle.len());
        } else {
            i += 1;
        }
    }
    words.join(" ")
}

/// Guarantee every visible name is unique, by re-attaching the detail (and then
/// a counter) to whichever rows collide. Two different devices must never read
/// as the same string.
fn uniquify_names(devices: &mut [AudioDevice]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for device in devices.iter() {
        *counts.entry(device.name.to_lowercase()).or_default() += 1;
    }

    let mut seen: HashMap<String, usize> = HashMap::new();
    for device in devices.iter_mut() {
        let key = device.name.to_lowercase();
        if counts.get(&key).copied().unwrap_or(0) <= 1 {
            continue;
        }
        let nth = seen.entry(key).or_insert(0);
        *nth += 1;
        match device.detail.clone() {
            Some(detail) => {
                device.name = format!("{} — {}", device.name, detail);
                device.detail = None;
            }
            None => {
                device.name = format!("{} ({})", device.name, nth);
            }
        }
    }

    // A detail can itself collide (two identical profiles on one card name).
    let mut used: HashSet<String> = HashSet::new();
    for device in devices.iter_mut() {
        let mut candidate = device.name.clone();
        let mut suffix = 2usize;
        while !used.insert(candidate.to_lowercase()) {
            candidate = format!("{} ({suffix})", device.name);
            suffix += 1;
        }
        device.name = candidate;
    }
}

// ── cpal naming fallback ────────────────────────────────────────────────────

/// Collapse the raw cpal list to one entry per real device.
///
/// On ALSA a single card yields `sysdefault:CARD=X`, `front:CARD=X,DEV=0`,
/// `surround40:CARD=X,DEV=0`, `plughw:CARD=X,DEV=0`, … — all the same hardware.
/// They are keyed by `(CARD, DEV)` and only the most generally usable PCM of
/// each group is kept. The chosen PCM's name stays the id, so a selection made
/// under the fallback still resolves later.
pub fn collapse_cpal_devices(raw: &[(usize, String, bool)]) -> Vec<AudioDevice> {
    // Preference order within one card: lower is better.
    fn rank(prefix: &str) -> u8 {
        match prefix {
            "plughw" => 0,
            "sysdefault" => 1,
            "front" => 2,
            "hdmi" => 3,
            "iec958" => 4,
            "hw" => 5,
            _ => 6, // surround*, dsnoop, dmix, …
        }
    }

    let mut grouped: BTreeMap<String, (u8, usize, String, bool)> = BTreeMap::new();
    let mut server_pcms: Vec<AudioDevice> = Vec::new();

    for (index, name, is_default) in raw {
        if is_server_pcm(name) {
            // `pipewire` / `pulse` / `default` all mean "the sound server".
            // They are not devices; the System default row covers them.
            let _ = index;
            continue;
        }
        let Some((prefix, card, dev)) = parse_alsa_pcm(name) else {
            server_pcms.push(AudioDevice {
                id: name.clone(),
                name: friendly_cpal_name(name),
                detail: None,
                is_default: *is_default,
                group: DeviceGroup::Device,
            });
            continue;
        };
        let key = format!("{card}\u{1}{}", dev.unwrap_or(0));
        let entry = (rank(&prefix), *index, name.clone(), *is_default);
        grouped
            .entry(key)
            .and_modify(|current| {
                // Keep the best PCM, but never lose the "is default" flag.
                let was_default = current.3;
                if entry.0 < current.0 {
                    *current = entry.clone();
                }
                current.3 |= was_default || entry.3;
            })
            .or_insert(entry);
    }

    let mut devices: Vec<AudioDevice> = grouped
        .into_values()
        .map(|(_, _, name, is_default)| AudioDevice {
            id: name.clone(),
            name: friendly_cpal_name(&name),
            detail: Some(name),
            is_default,
            group: DeviceGroup::Device,
        })
        .collect();
    devices.extend(server_pcms);

    uniquify_names(&mut devices);
    devices.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    devices
}

fn is_server_pcm(name: &str) -> bool {
    matches!(name, "pipewire" | "pulse" | "default" | "jack" | "oss")
}

/// Split an ALSA PCM name into `(prefix, CARD, DEV)`.
fn parse_alsa_pcm(name: &str) -> Option<(String, String, Option<u32>)> {
    let (prefix, rest) = name.split_once(':')?;
    let mut card = None;
    let mut dev = None;
    for part in rest.split(',') {
        let (key, value) = part.split_once('=')?;
        match key.trim() {
            "CARD" => card = Some(value.trim().to_string()),
            "DEV" => dev = value.trim().parse::<u32>().ok(),
            _ => {}
        }
    }
    Some((prefix.trim().to_string(), card?, dev))
}

/// Best-effort readable name for a raw cpal/ALSA PCM. Used only in the
/// no-sound-server fallback, where nothing better exists.
pub fn friendly_cpal_name(name: &str) -> String {
    match name {
        "default" => return "System default".to_string(),
        "pipewire" => return "PipeWire".to_string(),
        "pulse" => return "PulseAudio".to_string(),
        _ => {}
    }
    let Some((prefix, card, dev)) = parse_alsa_pcm(name) else {
        // WASAPI / CoreAudio already return product names.
        return name.to_string();
    };
    let card = card.replace('_', " ");
    let mut label = card;
    if prefix.eq_ignore_ascii_case("hdmi") {
        label = format!("{label} HDMI");
        if let Some(dev) = dev {
            label = format!("{label} {}", dev + 1);
        }
    } else if prefix.eq_ignore_ascii_case("iec958") {
        label = format!("{label} S/PDIF");
    }
    label
}

// ── Resolving a saved id back to something cpal can open ────────────────────

/// Resolve a persisted device id (or a legacy cpal index string) to the cpal
/// device to open and the node to pin the stream to.
pub fn resolve_target(direction: Direction, id: &str) -> Result<DeviceTarget, DeviceError> {
    let raw = raw_cpal_devices(direction)?;
    if raw.is_empty() {
        return Err(DeviceError::NoDevice(direction.noun()));
    }
    let wanted = id.trim();

    let default_display = query_default_node(direction).and_then(|default_name| {
        query_server_nodes(direction)?
            .iter()
            .find(|n| n.name == default_name)
            .map(|n| compose_name(n).0)
    });
    let default_target = |fell_back: bool| -> DeviceTarget {
        let (index, name) = server_pcm_index(&raw, false)
            .or_else(|| {
                raw.iter()
                    .find(|(_, _, is_default)| *is_default)
                    .map(|(i, n, _)| (*i, n.clone()))
            })
            .unwrap_or_else(|| (raw[0].0, raw[0].1.clone()));
        DeviceTarget {
            cpal_index: index,
            node: None,
            display_name: default_display
                .clone()
                .map(|resolved| format!("System default ({resolved})"))
                .unwrap_or_else(|| friendly_cpal_name(&name)),
            fell_back_to_default: fell_back,
        }
    };

    if wanted.is_empty()
        || wanted == SYSTEM_DEFAULT_ID
        || wanted.eq_ignore_ascii_case("default")
        || wanted.eq_ignore_ascii_case("communications")
    {
        return Ok(default_target(false));
    }

    // Sound-server node id: open the server PCM pinned to that node.
    if let Some(nodes) = query_server_nodes(direction) {
        if let Some(node) = nodes.iter().find(|n| n.name == wanted) {
            let (index, _) =
                server_pcm_index(&raw, true).ok_or(DeviceError::NoDevice(direction.noun()))?;
            let (display_name, _) = compose_name(node);
            return Ok(DeviceTarget {
                cpal_index: index,
                node: Some(node.name.clone()),
                display_name,
                fell_back_to_default: false,
            });
        }
        // Known-good id shape, but the device is gone. Say so.
        if wanted.contains('.') && (wanted.starts_with("alsa_") || wanted.contains('_')) {
            return Ok(default_target(true));
        }
    }

    // Fallback-list id: the cpal PCM name itself.
    if let Some((index, name, _)) = raw.iter().find(|(_, name, _)| name == wanted) {
        return Ok(DeviceTarget {
            cpal_index: *index,
            node: None,
            display_name: friendly_cpal_name(name),
            fell_back_to_default: false,
        });
    }

    // Legacy: a bare cpal enumeration index persisted by an older build.
    if let Ok(index) = wanted.parse::<usize>() {
        if let Some((_, name, _)) = raw.iter().find(|(i, _, _)| *i == index) {
            return Ok(DeviceTarget {
                cpal_index: index,
                node: None,
                display_name: friendly_cpal_name(name),
                fell_back_to_default: false,
            });
        }
    }

    Ok(default_target(true))
}

/// Index of the PCM that routes through the sound server.
///
/// The order depends on whether this open is aimed at a particular node,
/// because the two server PCMs do not both honor a target.
///
/// Measured on PipeWire 1.6.8 (`arecord -D <pcm>` + `pactl list source-outputs`):
///
/// | PCM        | env var        | stream landed on          |
/// |------------|----------------|---------------------------|
/// | `pipewire` | `PIPEWIRE_NODE`| the **default** source     |
/// | `pulse`    | `PULSE_SOURCE` | the **requested** node     |
///
/// `PIPEWIRE_NODE` is ignored because the shipped ALSA config
/// (`/usr/share/alsa/alsa.conf.d/99-pipewire-default.conf`) passes
/// `capture_node "-1"` / `playback_node "-1"` explicitly, and an explicit
/// plugin argument wins over the environment. So a device chosen in the picker
/// was resolved correctly, reported correctly, and then opened on whatever the
/// system default happened to be — silently right whenever the two agreed.
///
/// When a node is being targeted, prefer `pulse`, which does honor it. With no
/// target, keep `pipewire`: it is the shorter path to the same graph.
fn server_pcm_index(raw: &[(usize, String, bool)], targeted: bool) -> Option<(usize, String)> {
    let order: [&str; 3] = if targeted {
        ["pulse", "pipewire", "default"]
    } else {
        ["pipewire", "pulse", "default"]
    };
    for wanted in order {
        if let Some((index, name, _)) = raw.iter().find(|(_, name, _)| name == wanted) {
            return Some((*index, name.clone()));
        }
    }
    None
}

// ── ALSA's own chatter ──────────────────────────────────────────────────────

/// Stop ALSA writing its enumeration failures onto this process's stderr.
///
/// Every cpal enumeration walks every PCM the ALSA config names, and that list
/// includes the OSS compatibility shim. On a machine with no `/dev/dsp` — every
/// modern Linux box — each walk prints
/// `ALSA lib pcm_oss.c:404:(_snd_pcm_oss_open) Cannot open device /dev/dsp`
/// straight to stderr, four times a pass, dozens of times over a session. It is
/// noise about a device nobody asked for, and it buries the lines that matter.
///
/// ALSA lets a program own that output, so take it: install a handler that
/// drops the message. Nothing else in this process writes through
/// `snd_lib_error`, and the errors that *are* ours still come back as return
/// codes from `snd_pcm_open`, which is where we read them.
#[cfg(target_os = "linux")]
pub fn silence_alsa_probe_errors() {
    use std::os::raw::{c_char, c_int};
    use std::sync::Once;

    /// The real handler is variadic (`const char *fmt, ...`). Rust cannot
    /// *define* a C-variadic function on stable, so define one with the fixed
    /// prefix and transmute. This is ABI-safe in the only direction it is used:
    /// the callee simply never touches the variadic tail.
    unsafe extern "C" fn discard(
        _file: *const c_char,
        _line: c_int,
        _function: *const c_char,
        _err: c_int,
        _fmt: *const c_char,
    ) {
    }

    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let handler: alsa_sys::snd_lib_error_handler_t = Some(std::mem::transmute::<
            unsafe extern "C" fn(*const c_char, c_int, *const c_char, c_int, *const c_char),
            unsafe extern "C" fn(*const c_char, c_int, *const c_char, c_int, *const c_char, ...),
        >(discard));
        alsa_sys::snd_lib_error_set_handler(handler);
    });
}

/// No-op off Linux: ALSA is the only backend that narrates its probing.
#[cfg(not(target_os = "linux"))]
pub fn silence_alsa_probe_errors() {}

// ── Pinning a stream to a node for the duration of the open ─────────────────

/// Serializes the `PIPEWIRE_NODE` / `PULSE_*` window so two concurrent opens
/// cannot read each other's target.
static TARGET_ENV_LOCK: Mutex<()> = Mutex::new(());

/// Run `open` with this process's ALSA plugins pointed at `node`.
///
/// The PipeWire and PulseAudio ALSA plugins both read their target from the
/// environment at `snd_pcm_open` time, which is the only way to aim a cpal
/// stream at a specific node (cpal cannot open `pipewire:NODE=…` itself). The
/// variables are restored before returning, and only this process's own new
/// stream is affected — no system default is changed and no existing stream is
/// moved.
pub fn with_target_node<T>(
    direction: Direction,
    node: Option<&str>,
    open: impl FnOnce() -> T,
) -> T {
    let Some(node) = node else {
        return open();
    };
    let _guard = TARGET_ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let keys = ["PIPEWIRE_NODE", direction.pulse_env()];
    let saved: Vec<(&str, Option<OsString>)> =
        keys.iter().map(|k| (*k, std::env::var_os(k))).collect();
    for key in keys {
        std::env::set_var(key, node);
    }
    let result = open();
    for (key, previous) in saved {
        match previous {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, description: &str) -> ServerNode {
        ServerNode {
            name: name.to_string(),
            description: description.to_string(),
            device_description: None,
            profile_description: None,
            nick: None,
            is_monitor: false,
        }
    }

    #[test]
    fn a_name_the_server_said_twice_is_said_once() {
        assert_eq!(
            collapse_repeats("Scarlett Solo USB Direct Scarlett Solo USB"),
            "Scarlett Solo USB Direct"
        );
        assert_eq!(
            collapse_repeats("Odyssey G95SC Tuned"),
            "Odyssey G95SC Tuned"
        );
        assert_eq!(
            collapse_repeats(
                "AD103 High Definition Audio Controller Digital Stereo (HDMI) [Odyssey G95SC]"
            ),
            "AD103 High Definition Audio Controller Digital Stereo (HDMI) [Odyssey G95SC]"
        );
    }

    #[test]
    fn a_card_with_a_nicer_nickname_is_called_by_it() {
        let mut n = node(
            "alsa_output.pci-0000_01_00.1.hdmi-stereo",
            "AD103 High Definition Audio Controller Digital Stereo (HDMI) [Odyssey G95SC]",
        );
        n.device_description = Some("AD103 High Definition Audio Controller".into());
        n.profile_description = Some("Digital Stereo (HDMI)".into());
        n.nick = Some("Odyssey G95SC".into());
        let (name, detail) = compose_name(&n);
        assert_eq!(name, "Odyssey G95SC");
        assert_eq!(detail.as_deref(), Some("Digital Stereo (HDMI)"));
    }

    #[test]
    fn a_microphone_keeps_the_product_name_and_moves_the_profile_aside() {
        let mut n = node(
            "alsa_input.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__source",
            "Scarlett Solo USB Direct Scarlett Solo USB",
        );
        n.device_description = Some("Scarlett Solo USB".into());
        n.profile_description = Some("Direct Scarlett Solo USB".into());
        n.nick = Some("Scarlett Solo USB".into());
        let (name, detail) = compose_name(&n);
        assert_eq!(name, "Scarlett Solo USB");
        assert_eq!(detail.as_deref(), Some("Direct"));
    }

    #[test]
    fn two_identical_cards_never_read_as_one_device() {
        let list = build_device_list(
            &[
                ServerNode {
                    name: "alsa_output.card_a".into(),
                    description: "Generic Audio".into(),
                    device_description: Some("Generic Audio".into()),
                    profile_description: Some("Analog Stereo".into()),
                    nick: None,
                    is_monitor: false,
                },
                ServerNode {
                    name: "alsa_output.card_b".into(),
                    description: "Generic Audio".into(),
                    device_description: Some("Generic Audio".into()),
                    profile_description: Some("Analog Stereo".into()),
                    nick: None,
                    is_monitor: false,
                },
            ],
            None,
        );
        let names: Vec<&str> = list.devices.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names.len(), 3, "system default + two devices: {names:?}");
        assert_ne!(names[1], names[2], "two cards collapsed to one string");
    }

    #[test]
    fn a_monitor_is_kept_out_of_the_microphone_group() {
        let list = build_device_list(
            &[
                ServerNode {
                    name: "alsa_input.mic".into(),
                    description: "Scarlett Solo USB".into(),
                    device_description: Some("Scarlett Solo USB".into()),
                    profile_description: None,
                    nick: None,
                    is_monitor: false,
                },
                ServerNode {
                    name: "alsa_output.hdmi.monitor".into(),
                    description: "Monitor of AD103".into(),
                    device_description: None,
                    profile_description: None,
                    nick: None,
                    is_monitor: true,
                },
            ],
            Some("alsa_input.mic"),
        );
        assert_eq!(list.devices[0].group, DeviceGroup::SystemDefault);
        assert_eq!(
            list.devices[0].detail.as_deref(),
            Some("Currently: Scarlett Solo USB")
        );
        assert_eq!(list.devices[1].group, DeviceGroup::Device);
        assert_eq!(list.devices[2].group, DeviceGroup::Monitor);
    }

    #[test]
    fn one_card_is_one_choice_when_only_alsa_can_answer() {
        let raw = vec![
            (0usize, "pipewire".to_string(), false),
            (1, "pulse".to_string(), false),
            (2, "default".to_string(), true),
            (3, "sysdefault:CARD=USB".to_string(), false),
            (4, "front:CARD=USB,DEV=0".to_string(), false),
            (5, "surround40:CARD=USB,DEV=0".to_string(), false),
            (6, "hdmi:CARD=NVidia,DEV=1".to_string(), false),
            (7, "hdmi:CARD=NVidia,DEV=2".to_string(), false),
        ];
        let devices = collapse_cpal_devices(&raw);
        let names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            devices.len(),
            3,
            "one USB card + two HDMI outputs, got {names:?}"
        );
        assert!(devices.iter().any(|d| d.id == "sysdefault:CARD=USB"));
        assert!(!devices.iter().any(|d| d.id.starts_with("surround")));
        // Distinct HDMI outputs stay distinct.
        assert_ne!(names[1], names[2]);
    }

    #[test]
    fn an_alsa_pcm_name_splits_into_card_and_device() {
        assert_eq!(
            parse_alsa_pcm("front:CARD=Generic_1,DEV=0"),
            Some(("front".into(), "Generic_1".into(), Some(0)))
        );
        assert_eq!(
            parse_alsa_pcm("sysdefault:CARD=USB"),
            Some(("sysdefault".into(), "USB".into(), None))
        );
        assert_eq!(parse_alsa_pcm("MacBook Pro Microphone"), None);
    }

    #[test]
    fn a_friendly_platform_name_is_left_alone() {
        // WASAPI / CoreAudio already return product names: do not regress them.
        assert_eq!(
            friendly_cpal_name("Headset (Arctis Nova Pro Wireless)"),
            "Headset (Arctis Nova Pro Wireless)"
        );
        assert_eq!(
            friendly_cpal_name("MacBook Pro Speakers"),
            "MacBook Pro Speakers"
        );
    }

    /// Measured on PipeWire 1.6.8: `arecord -D pipewire` with `PIPEWIRE_NODE`
    /// set lands on the *default* source, while `arecord -D pulse` with
    /// `PULSE_SOURCE` set lands on the *requested* one — the shipped ALSA config
    /// passes `capture_node "-1"` explicitly and an explicit plugin argument
    /// beats the environment. So an open that is aimed at a node must go through
    /// the PCM that can be aimed.
    #[test]
    fn an_aimed_open_takes_the_pcm_that_can_be_aimed() {
        let raw = vec![
            (0, "pipewire".to_string(), false),
            (1, "pulse".to_string(), false),
            (2, "default".to_string(), true),
        ];
        assert_eq!(
            server_pcm_index(&raw, true),
            Some((1, "pulse".to_string())),
            "a targeted open must use the pulse PCM"
        );
        assert_eq!(
            server_pcm_index(&raw, false),
            Some((0, "pipewire".to_string())),
            "an untargeted open keeps the shorter pipewire path"
        );
    }

    /// With no `pulse` PCM there is still a sound server to reach; fall through
    /// rather than refusing to open anything.
    #[test]
    fn a_machine_without_the_pulse_pcm_still_opens_something() {
        let raw = vec![
            (0, "pipewire".to_string(), false),
            (1, "default".to_string(), true),
        ];
        assert_eq!(
            server_pcm_index(&raw, true).map(|(i, _)| i),
            Some(0),
            "no pulse PCM: fall through to pipewire"
        );
        let only_default = vec![(0, "default".to_string(), true)];
        assert_eq!(
            server_pcm_index(&only_default, true).map(|(i, _)| i),
            Some(0)
        );
        assert_eq!(server_pcm_index(&[], true), None);
    }

    #[test]
    fn nothing_selected_means_the_system_default() {
        // Resolution against the real host is covered by the proof example;
        // here we only pin the reserved id's spelling.
        assert_eq!(SYSTEM_DEFAULT_ID, "@default");
    }
}
