use clap::{Args as ClapArgs, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "paracord-server", about = "Paracord chat server")]
pub struct Args {
    /// Path to configuration file
    #[arg(short, long, default_value = "config/paracord.toml")]
    pub config: String,

    /// Path to directory containing built web UI files (overrides config)
    #[arg(long)]
    pub web_dir: Option<String>,

    /// Optional maintenance subcommand. When omitted, the chat server runs.
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Copy all data from a SQLite database into a PostgreSQL database.
    ///
    /// Runs the PostgreSQL migrations against the target, then copies every
    /// table inside a single transaction. Every table's row count is verified
    /// against the source; any mismatch rolls the whole transaction back, so
    /// the target is left untouched on failure. Stop the server (and ensure the
    /// SQLite file is not being written) before running this.
    MigrateToPostgres(MigrateToPostgresArgs),

    /// Generate the config file (if absent) and print onboarding instructions,
    /// then exit without starting the server.
    ///
    /// This is a convenience wrapper around the normal zero-config first run:
    /// it writes the default config using the same generation path, prints the
    /// URL to open/share and the first-run "Next steps" block, and exits 0. If
    /// the config already exists it is reported as ready and never overwritten.
    Init(InitArgs),
}

#[derive(ClapArgs, Debug)]
pub struct InitArgs {
    /// Path to write (or check) the configuration file. Defaults to the
    /// top-level `--config` value when omitted.
    #[arg(short, long)]
    pub config: Option<String>,
}

#[derive(ClapArgs, Debug)]
pub struct MigrateToPostgresArgs {
    /// Source SQLite database URL (e.g. sqlite://./data/paracord.db).
    #[arg(long)]
    pub source: String,

    /// Target PostgreSQL database URL (e.g. postgres://user:pass@host/db).
    #[arg(long)]
    pub target: String,

    /// Number of rows read per page while streaming each table.
    #[arg(long, default_value_t = 1000)]
    pub batch_size: u32,

    /// Validate row counts and column mappings without writing any data.
    #[arg(long)]
    pub dry_run: bool,
}
