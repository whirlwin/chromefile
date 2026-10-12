//! chromefile: installs, inspects and removes the Claude Browser Bridge
//! extension in the running Google Chrome on macOS.

mod chrome;
mod commands;
mod embedded;
mod files;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    version,
    about = "Installs, inspects and removes the Claude Browser Bridge extension in Google Chrome (macOS)",
    after_help = "Chrome must be running with View > Developer > Allow JavaScript from Apple Events \
                  turned on. install also needs Accessibility permission for your terminal app, \
                  to type the folder into Chrome's Load unpacked picker."
)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Install or update the extension, turn on developer mode and Allow User Scripts.
    Install {
        /// If the extension is loaded from another folder (a dev checkout,
        /// say), remove that copy first. This deletes its registered user
        /// scripts (mods) and storage.
        #[arg(long)]
        replace: bool,
    },
    /// Show whether the extension is installed and matches this build (read-only).
    Status,
    /// Remove the extension and its files.
    Uninstall,
}

fn config() -> Result<commands::Config> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    // Test-only overrides; see README.md.
    let app = std::env::var("CHROMEFILE_CHROME_APP").unwrap_or_else(|_| "Google Chrome".into());
    let base = match std::env::var_os("CHROMEFILE_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => match &home {
            Some(h) => h.join("Library/Application Support/chromefile"),
            None => bail!("HOME is not set"),
        },
    };
    // The extension folder is deleted and pruned freely, so make sure it
    // can't end up being the home folder or the filesystem root.
    if !base.is_absolute() || base.parent().is_none() || Some(&base) == home.as_ref() {
        bail!(
            "refusing to use {} as the chromefile folder; CHROMEFILE_HOME must be an absolute \
             folder other than / and your home folder",
            base.display()
        );
    }
    Ok(commands::Config {
        app,
        stable_dir: base.join("extensions").join(embedded::NAME),
        home,
    })
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let item = format!("extension {}", embedded::NAME);

    if std::env::consts::OS != "macos" {
        eprintln!("{item}: unsupported (chromefile runs on macOS only)");
        return ExitCode::FAILURE;
    }
    chrome::catch_sigint();

    let result = config().and_then(|config| match cli.command {
        Cmd::Install { replace } => commands::install(&config, replace).map(|_| true),
        Cmd::Status => commands::status(&config),
        Cmd::Uninstall => commands::uninstall(&config).map(|_| true),
    });
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            if chrome::interrupted() {
                eprintln!("{item}: failed (interrupted)");
                return ExitCode::from(130);
            }
            eprintln!("{item}: failed\nerror: {e:#}");
            ExitCode::FAILURE
        }
    }
}
