use clap::{Args as ClapArgs, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "paracord-server", about = "Paracord chat server", version)]
pub struct Args {
    /// Path to configuration file
    #[arg(short, long, default_value = "config/paracord.toml")]
    pub config: String,

    /// Path to directory containing built web UI files (overrides config)
    #[arg(long)]
    pub web_dir: Option<String>,

    /// Also write the log to this file (same lines as stdout, secrets removed),
    /// rotated daily with seven days kept. The desktop host always passes it.
    #[arg(long, global = true)]
    pub log_file: Option<std::path::PathBuf>,

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
    /// copied rows roll back on failure. Target schema migrations and their seed
    /// rows remain applied. Keep both databases offline while running this.
    MigrateToPostgres(MigrateToPostgresArgs),

    /// Prepare and verify an isolated archive recovery. Existing server data is
    /// retained; activate by selecting the generated config after stopping all instances.
    RestoreBackup(RestoreBackupArgs),

    /// Generate the config file (if absent) and print onboarding instructions,
    /// then exit without starting the server.
    ///
    /// This is a convenience wrapper around the normal zero-config first run:
    /// it writes the default config using the same generation path, prints the
    /// URL to open/share and the first-run "Next steps" block, and exits 0. If
    /// the config already exists it is reported as ready and never overwritten.
    Init(InitArgs),

    /// Encrypt an existing server's stored data: the SQLite database with
    /// SQLCipher and every attachment file (docs/setup-spec.md §4.8).
    ///
    /// Stop the server first (this refuses while its port answers). Takes a
    /// backup, generates a storage key and stores it in --key-source, copies
    /// the database into an encrypted one and compares every table's rows,
    /// encrypts files in place, then turns [at_rest] on in the config. An
    /// interrupted run picks up where it stopped when run again.
    EncryptStorage(EncryptStorageArgs),
}

/// Where `encrypt-storage` keeps the new key.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySourceArg {
    /// The system keychain of the user the server runs as.
    Keychain,
    /// A systemd credential (`systemd-creds encrypt`), written to --key-file.
    #[value(name = "systemd-creds")]
    SystemdCreds,
    /// A key file readable only by the server's user (--key-file).
    File,
    /// The key already in [at_rest] key_env (you make it, e.g. `openssl rand -hex 32`).
    Env,
}

impl From<KeySourceArg> for paracord_contracts::host::KeySource {
    fn from(value: KeySourceArg) -> Self {
        use paracord_contracts::host::KeySource;
        match value {
            KeySourceArg::Keychain => KeySource::Keychain,
            KeySourceArg::SystemdCreds => KeySource::SystemdCreds,
            KeySourceArg::File => KeySource::File,
            KeySourceArg::Env => KeySource::Env,
        }
    }
}

#[derive(ClapArgs, Debug)]
pub struct EncryptStorageArgs {
    /// Where the new storage key goes.
    #[arg(long, value_enum)]
    pub key_source: KeySourceArg,
    /// `file`: the key file to create (default: at-rest.key beside the config).
    /// `systemd-creds`: the encrypted credential to create.
    #[arg(long)]
    pub key_file: Option<std::path::PathBuf>,
}

#[derive(ClapArgs, Debug)]
pub struct InitArgs {
    /// Path to write (or check) the configuration file. Defaults to the
    /// top-level `--config` value when omitted. Ignored with `--profile`, which
    /// writes `<root>/config/paracord.toml`.
    #[arg(short, long)]
    pub config: Option<String>,

    /// Write a ready-made configuration for a particular way of running
    /// instead of the generic one.
    #[arg(long, value_enum)]
    pub profile: Option<InitProfile>,

    /// `--profile desktop-host`: the host root directory (absolute paths are
    /// written under it).
    #[arg(long)]
    pub root: Option<std::path::PathBuf>,

    /// `--profile desktop-host`: the port for HTTPS and voice.
    #[arg(long)]
    pub port: Option<u16>,
}

/// Named configurations for `init --profile`.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitProfile {
    /// "Paracord on this computer": the desktop app's background server
    /// (docs/setup-spec.md §2.7).
    #[value(name = "desktop-host")]
    DesktopHost,
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

    /// Apply target schema migrations and seeds, then validate source counts and
    /// column mappings without copying source rows or rotating an existing epoch.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(ClapArgs, Debug)]
pub struct RestoreBackupArgs {
    /// Archive created by Paracord backup (.tar.gz), never a raw database dump.
    #[arg(long)]
    pub archive: std::path::PathBuf,
    /// New recovery directory. Must not exist; its parent must exist.
    #[arg(long)]
    pub output_dir: std::path::PathBuf,
    /// Environment variable containing the URL of a fresh, isolated PostgreSQL database.
    /// Required for PostgreSQL archives; never point it at the running database.
    #[arg(long)]
    pub postgres_url_env: Option<String>,
    /// Matching external media export with uploads/ and files/ subdirectories.
    /// Required for database-only archives or exported S3 objects.
    #[arg(long)]
    pub media_dir: Option<std::path::PathBuf>,
    /// Maximum unpacked archive bytes and maximum external media export bytes.
    #[arg(long, default_value_t = 68_719_476_736)]
    pub max_unpacked_bytes: u64,
    /// Read the owner's escrow key (b64url, one line) from standard input,
    /// unwrap the storage key from the archive's escrow and store it in the
    /// config's key source before restoring (docs/setup-spec.md §4.7, §4.8).
    #[arg(long)]
    pub escrow_key_stdin: bool,
}
