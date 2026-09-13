use std::{env, fs, path::PathBuf, process::ExitCode};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut check = false;
    let mut destination = None;
    for arg in env::args_os().skip(1) {
        if arg == "--check" {
            check = true;
        } else if destination.is_none() {
            destination = Some(PathBuf::from(arg));
        } else {
            return Err("Usage: export-contracts [--check] <output.json>".into());
        }
    }
    let destination = destination.ok_or("Usage: export-contracts [--check] <output.json>")?;
    let contents = format!(
        "{}\n",
        serde_json::to_string_pretty(&paracord_contracts::schemas())?
    );
    if check {
        if fs::read_to_string(&destination)? != contents {
            return Err(format!(
                "{} is stale; regenerate API contracts",
                destination.display()
            )
            .into());
        }
    } else {
        if let Some(parent) = destination.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        fs::write(destination, contents)?;
    }
    Ok(())
}
