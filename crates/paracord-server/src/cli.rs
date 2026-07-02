use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "paracord-server", about = "Paracord chat server")]
pub struct Args {
    /// Path to configuration file
    #[arg(short, long, default_value = "config/paracord.toml")]
    pub config: String,

    /// Path to directory containing built web UI files (overrides config)
    #[arg(long)]
    pub web_dir: Option<String>,
}
