//! chromefile: installs, inspects and removes the Chromefile extension, its
//! native messaging host and its Claude Code MCP server on macOS, applies
//! Chromefiles to Chrome (`apply`), and runs the embedded Node host for
//! Chrome (`host`), Claude Code (`mcp`) and scripts (`call`).

mod apply;
mod chrome;
mod chromefile;
mod commands;
mod embedded;
mod files;
mod host;
mod setup;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    version,
    about = "Installs, inspects and removes the Chromefile extension, native host and MCP server, and applies Chromefiles (macOS)",
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
    /// Install or update everything: the host, native host manifests, the MCP
    /// server and the extension (developer mode, Allow User Scripts).
    Install {
        /// If the extension is loaded from another folder (a dev checkout,
        /// say), remove that copy first. This deletes its registered user
        /// scripts (mods) and storage.
        #[arg(long)]
        replace: bool,
        /// Leave the extension in Chrome alone (for tests).
        #[arg(long)]
        skip_extension: bool,
    },
    /// Show what is installed and whether it matches this build (read-only).
    Status {
        /// Don't ask Chrome about the extension (for tests).
        #[arg(long)]
        skip_extension: bool,
    },
    /// Remove everything install set up, except config.json and sessions/.
    Uninstall {
        /// Leave the extension in Chrome alone (for tests).
        #[arg(long)]
        skip_extension: bool,
    },
    /// Apply a Chromefile (tab layout, hotkeys) to Chrome. Supports Chromefile
    /// specification version 1.
    ///
    /// Validates the whole file first and changes nothing if it is invalid.
    /// Reports each setting as changed, unchanged, failed or unsupported, and
    /// exits 1 if the file is invalid or any setting failed. Hotkeys need the
    /// Chromefile extension (chromefile install).
    Apply {
        /// Report what would change without changing anything.
        #[arg(long)]
        dry_run: bool,
        /// The Chromefile to apply. Default: ./Chromefile if it exists, else
        /// $XDG_CONFIG_HOME/chromefile/Chromefile (~/.config/chromefile/Chromefile).
        path: Option<PathBuf>,
    },
    /// Run the MCP server over stdio (what Claude Code starts).
    Mcp,
    /// Send one request to the extension and print the result as JSON.
    Call {
        /// The method, then optional JSON params.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<OsString>,
    },
    /// Run the native messaging host (what Chrome starts).
    #[command(hide = true)]
    Host {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<OsString>,
    },
}

/// The app folder: ~/Library/Application Support/chromefile, or the
/// test-only CHROMEFILE_HOME.
fn app_dir(home: Option<&Path>) -> Result<PathBuf> {
    let dir = match std::env::var_os("CHROMEFILE_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => match home {
            Some(h) => h.join("Library/Application Support/chromefile"),
            None => bail!("HOME is not set"),
        },
    };
    // Folders in here are deleted and pruned freely, so make sure it can't
    // end up being the home folder or the filesystem root.
    if !dir.is_absolute() || dir.parent().is_none() || Some(dir.as_path()) == home {
        bail!(
            "refusing to use {} as the chromefile folder; CHROMEFILE_HOME must be an absolute \
             folder other than / and your home folder",
            dir.display()
        );
    }
    Ok(dir)
}

fn setup_env() -> Result<setup::Env> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let app_dir = app_dir(home.as_deref())?;
    // Test-only overrides; see cli/README.md.
    let browser_root = match std::env::var_os("CHROMEFILE_BROWSER_ROOT") {
        Some(dir) => PathBuf::from(dir),
        None => match &home {
            Some(h) => h.join("Library/Application Support"),
            None => bail!("HOME is not set"),
        },
    };
    if !browser_root.is_absolute() {
        bail!("CHROMEFILE_BROWSER_ROOT must be an absolute folder");
    }
    let claude = match std::env::var_os("CHROMEFILE_CLAUDE") {
        Some(path) => Some(PathBuf::from(path)),
        None => host::which("claude"),
    };
    let exe = std::env::current_exe()?.canonicalize()?;
    Ok(setup::Env {
        app_dir,
        browser_root,
        home,
        exe,
        claude,
    })
}

/// The browser's application name: CHROMEFILE_CHROME_APP (for tests), else
/// Google Chrome.
fn chrome_app() -> String {
    std::env::var("CHROMEFILE_CHROME_APP").unwrap_or_else(|_| "Google Chrome".into())
}

fn extension_config(env: &setup::Env) -> commands::Config {
    commands::Config {
        app: chrome_app(),
        stable_dir: env.app_dir.join("extension"),
        legacy_dir: env.app_dir.join("extensions"),
        home: env.home.clone(),
    }
}

/// Hands over to the Node host. Only returns on failure.
fn run_node(mode: &str, args: &[OsString]) -> ExitCode {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let e = match app_dir(home.as_deref()) {
        Ok(dir) => host::exec(&dir, mode, args),
        Err(e) => e,
    };
    eprintln!("chromefile {mode}: {e:#}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    // Chrome starts a native host as `<path> chrome-extension://<id>/ [...]`.
    let args: Vec<OsString> = std::env::args_os().collect();
    if host::is_host_invocation(args.get(1).map(OsString::as_os_str)) {
        return run_node("host", &args[1..]);
    }

    let cli = Cli::parse();
    let (install, skip_extension) = match cli.command {
        Cmd::Mcp => return run_node("mcp", &[]),
        Cmd::Call { args } => return run_node("call", &args),
        Cmd::Host { args } => return run_node("host", &args),
        // Before the macOS check: validating a file works anywhere, and apply
        // reports what it can't do elsewhere per setting.
        Cmd::Apply { dry_run, path } => return apply::run(path, dry_run, &chrome_app()),
        Cmd::Install { skip_extension, .. }
        | Cmd::Status { skip_extension }
        | Cmd::Uninstall { skip_extension } => (cli.command, skip_extension),
    };

    if std::env::consts::OS != "macos" {
        eprintln!("chromefile: unsupported (install, status and uninstall run on macOS only)");
        return ExitCode::FAILURE;
    }
    chrome::catch_sigint();

    let env = match setup_env() {
        Ok(env) => env,
        Err(e) => {
            eprintln!("error: {e:#}");
            return ExitCode::FAILURE;
        }
    };
    let config = extension_config(&env);
    let mut report = setup::Report::default();

    let result = match install {
        Cmd::Install { replace, .. } => {
            setup::install(&env, &mut report);
            if skip_extension {
                Ok(true)
            } else {
                commands::install(&config, replace).map(|_| true)
            }
        }
        Cmd::Status { .. } => {
            let ok = setup::status(&env);
            if skip_extension {
                Ok(ok)
            } else {
                commands::status(&config).map(|ext| ext && ok)
            }
        }
        Cmd::Uninstall { .. } => {
            let ext = if skip_extension {
                Ok(())
            } else {
                commands::uninstall(&config)
            };
            // The rest goes even if the extension could not be removed.
            if !chrome::interrupted() {
                setup::uninstall(&env, &mut report);
            }
            ext.map(|_| true)
        }
        _ => unreachable!("handled above"),
    };
    match result {
        Ok(true) if !report.failed => ExitCode::SUCCESS,
        Ok(_) => ExitCode::FAILURE,
        Err(e) => {
            if chrome::interrupted() {
                eprintln!("extension: failed (interrupted)");
                return ExitCode::from(130);
            }
            eprintln!("extension: failed\nerror: {e:#}");
            ExitCode::FAILURE
        }
    }
}
