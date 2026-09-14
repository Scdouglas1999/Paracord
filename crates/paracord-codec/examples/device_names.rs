//! Before/after proof for audio device naming.
//!
//! Prints the OLD enumeration (raw cpal, one row per ALSA PCM route) next to
//! the NEW one (sound-server node descriptions with stable node ids) for the
//! machine it is run on. Run it on a box with real hardware attached:
//!
//! ```text
//! cargo run -p paracord-codec --example device_names 2>/dev/null
//! ```
//!
//! Not a CI target — it needs a sound server and real devices to say anything.

use paracord_codec::audio::devices::{
    self, AudioDevice, DeviceGroup, DeviceList, Direction, SYSTEM_DEFAULT_ID,
};

fn main() {
    // `--open-output <id>` opens a (silent) playback stream on that device and
    // holds it for a few seconds, so `pactl list sink-inputs` can be used to
    // check the stream really landed on the chosen node rather than the default.
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--open-output") {
        let id = args.get(pos + 1).map(String::as_str).unwrap_or("@default");
        match paracord_codec::audio::playback::AudioPlayback::start_device_id(id, None) {
            Ok((playback, target)) => {
                println!(
                    "opened output {:?} (node={:?}, cpal index {}, fell back: {})",
                    target.display_name,
                    target.node,
                    target.cpal_index,
                    target.fell_back_to_default
                );
                std::thread::sleep(std::time::Duration::from_secs(6));
                playback.stop();
            }
            Err(err) => println!("failed to open {id}: {err}"),
        }
        return;
    }

    for direction in [Direction::Input, Direction::Output] {
        let heading = match direction {
            Direction::Input => "MICROPHONES (input)",
            Direction::Output => "SPEAKERS / HEADPHONES (output)",
        };
        println!("\n{heading}");
        println!("{}", "=".repeat(heading.len()));

        println!("\n--- BEFORE: cpal device.name() --------------------------------");
        match devices::raw_cpal_devices(direction) {
            Ok(raw) => {
                for (index, name, is_default) in &raw {
                    println!(
                        "  [{index:>2}] {name}{}",
                        if *is_default { "   <- default" } else { "" }
                    );
                }
                println!("  ({} entries)", raw.len());
            }
            Err(err) => println!("  error: {err}"),
        }

        println!("\n--- AFTER: sound-server devices -------------------------------");
        match devices::list_devices(direction) {
            Ok(list) => print_new(&list),
            Err(err) => println!("  error: {err}"),
        }
    }

    println!("\n\nRESOLUTION (what a saved selection opens)");
    println!("=========================================");
    for direction in [Direction::Input, Direction::Output] {
        let Ok(list) = devices::list_devices(direction) else {
            continue;
        };
        for device in list
            .devices
            .iter()
            .filter(|d| d.group != DeviceGroup::Monitor)
        {
            match devices::resolve_target(direction, &device.id) {
                Ok(target) => println!(
                    "  {:<28} id={:<62} -> cpal[{}] {:<10} node={}",
                    device.name,
                    device.id,
                    target.cpal_index,
                    if target.fell_back_to_default {
                        "(FELL BACK)"
                    } else {
                        ""
                    },
                    target.node.as_deref().unwrap_or("<system default>")
                ),
                Err(err) => println!("  {:<28} -> error: {err}", device.name),
            }
        }
    }

    println!("\n  A device that was unplugged since it was saved:");
    for direction in [Direction::Input, Direction::Output] {
        let gone = "alsa_input.usb-Some_Unplugged_Headset-00.mono-fallback";
        match devices::resolve_target(direction, gone) {
            Ok(target) => println!(
                "    {:?}: {gone}\n      -> {} (fell back to default: {})",
                direction, target.display_name, target.fell_back_to_default
            ),
            Err(err) => println!("    {direction:?}: error: {err}"),
        }
    }
    println!("\n  \"{SYSTEM_DEFAULT_ID}\" always re-resolves at open time.");
}

fn print_new(list: &DeviceList) {
    if let Some(warning) = &list.warning {
        println!("  ! {warning}");
    }
    println!("  backend: {}", list.backend.as_str());
    let mut group_shown: Option<DeviceGroup> = None;
    for device in &list.devices {
        if group_shown != Some(device.group) {
            group_shown = Some(device.group);
            let label = match device.group {
                DeviceGroup::SystemDefault => "",
                DeviceGroup::Device => "\n  Devices",
                DeviceGroup::Monitor => "\n  What is playing (system audio)",
            };
            if !label.is_empty() {
                println!("{label}");
            }
        }
        print_device(device);
    }
    println!(
        "  ({} rows, {} selectable devices)",
        list.devices.len(),
        list.devices
            .iter()
            .filter(|d| d.group == DeviceGroup::Device)
            .count()
    );
}

fn print_device(device: &AudioDevice) {
    let detail = device
        .detail
        .as_deref()
        .map(|d| format!("  — {d}"))
        .unwrap_or_default();
    println!(
        "    {}{}{}",
        device.name,
        detail,
        if device.is_default && device.group != DeviceGroup::SystemDefault {
            "   <- default"
        } else {
            ""
        }
    );
    println!("        id: {}", device.id);
}
