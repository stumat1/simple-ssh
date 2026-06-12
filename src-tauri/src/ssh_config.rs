//! Minimal one-way importer for OpenSSH client config (`~/.ssh/config`).
//!
//! Parses `Host` blocks into profile candidates. Deliberately not a full
//! implementation: wildcard host patterns and `Match` blocks are skipped, and
//! only the directives a profile can represent (HostName, Port, User,
//! IdentityFile) are read — first value wins, like OpenSSH.

use std::path::{Path, PathBuf};

/// A profile candidate extracted from one `Host` alias.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedHost {
    /// The alias (becomes the profile name).
    pub name: String,
    pub host: String,
    pub port: u16,
    /// Empty when the block has no `User` directive.
    pub username: String,
    pub identity_file: Option<String>,
}

fn is_pattern(alias: &str) -> bool {
    alias.contains('*') || alias.contains('?') || alias.starts_with('!')
}

/// Split a config line into (key, value). Supports `Key Value` and `Key=Value`,
/// strips surrounding double quotes from the value.
fn split_directive(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, value) = match line.split_once(['=', ' ', '\t']) {
        Some((k, v)) => (k, v),
        None => return None,
    };
    let value = value.trim().trim_start_matches('=').trim();
    let value = value.strip_prefix('"').unwrap_or(value);
    let value = value.strip_suffix('"').unwrap_or(value);
    if value.is_empty() {
        return None;
    }
    Some((key.trim().to_ascii_lowercase(), value.to_string()))
}

/// Expand `~` and `%d` (both meaning the user's home directory) in a path.
fn expand_home(path: &str, home: &Path) -> String {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.join(rest).to_string_lossy().into_owned();
    }
    if path == "~" {
        return home.to_string_lossy().into_owned();
    }
    path.replace("%d", &home.to_string_lossy())
}

#[derive(Default)]
struct Block {
    aliases: Vec<String>,
    hostname: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    identity_file: Option<String>,
}

impl Block {
    fn finish(self, out: &mut Vec<ImportedHost>) {
        for alias in self.aliases {
            out.push(ImportedHost {
                host: self.hostname.clone().unwrap_or_else(|| alias.clone()),
                port: self.port.unwrap_or(22),
                username: self.user.clone().unwrap_or_default(),
                identity_file: self.identity_file.clone(),
                name: alias,
            });
        }
    }
}

/// Parse config text into profile candidates (one per concrete `Host` alias).
pub fn parse(text: &str, home: &Path) -> Vec<ImportedHost> {
    let mut hosts = Vec::new();
    // None = before any Host block, or inside a skipped Match/wildcard block.
    let mut current: Option<Block> = None;

    for line in text.lines() {
        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                if let Some(block) = current.take() {
                    block.finish(&mut hosts);
                }
                let aliases: Vec<String> = value
                    .split_whitespace()
                    .filter(|a| !is_pattern(a))
                    .map(str::to_string)
                    .collect();
                if !aliases.is_empty() {
                    current = Some(Block {
                        aliases,
                        ..Block::default()
                    });
                }
            }
            "match" => {
                if let Some(block) = current.take() {
                    block.finish(&mut hosts);
                }
            }
            _ => {
                let Some(block) = current.as_mut() else {
                    continue;
                };
                match key.as_str() {
                    "hostname" if block.hostname.is_none() => block.hostname = Some(value),
                    "port" if block.port.is_none() => block.port = value.parse().ok(),
                    "user" if block.user.is_none() => block.user = Some(value),
                    "identityfile" if block.identity_file.is_none() => {
                        block.identity_file = Some(expand_home(&value, home));
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(block) = current.take() {
        block.finish(&mut hosts);
    }
    hosts
}

/// The user's home directory (`%USERPROFILE%`, falling back to `$HOME`).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Default location of the user's OpenSSH client config.
pub fn default_config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh").join("config"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("C:\\Users\\test")
    }

    #[test]
    fn parses_basic_blocks() {
        let text = r#"
# personal boxes
Host web
    HostName web.example.com
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host db backup
    HostName 10.0.0.5
"#;
        let hosts = parse(text, &home());
        assert_eq!(hosts.len(), 3);
        assert_eq!(hosts[0].name, "web");
        assert_eq!(hosts[0].host, "web.example.com");
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].username, "deploy");
        // Mixed separators are fine — Windows APIs accept forward slashes.
        assert_eq!(
            hosts[0].identity_file.as_deref(),
            Some("C:\\Users\\test\\.ssh/id_ed25519")
        );
        // Multi-alias block yields one candidate per alias, same settings.
        assert_eq!(hosts[1].name, "db");
        assert_eq!(hosts[1].host, "10.0.0.5");
        assert_eq!(hosts[1].port, 22);
        assert_eq!(hosts[2].name, "backup");
    }

    #[test]
    fn skips_wildcards_and_match_blocks() {
        let text = r#"
Host *
    User everyone

Host web !web.internal
    HostName web.example.com

Match user root
    IdentityFile ~/.ssh/root_key

Host plain
"#;
        let hosts = parse(text, &home());
        let names: Vec<&str> = hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["web", "plain"]);
        // Directives in skipped blocks must not leak into later blocks.
        assert_eq!(hosts[0].username, "");
        assert_eq!(hosts[1].identity_file, None);
        // HostName defaults to the alias.
        assert_eq!(hosts[1].host, "plain");
    }

    #[test]
    fn supports_equals_and_quotes_and_first_wins() {
        let text = r#"
Host eq
    HostName=eq.example.com
    User = "alice"
    IdentityFile "%d\.ssh\key one"
    IdentityFile ~/.ssh/second
"#;
        let hosts = parse(text, &home());
        assert_eq!(hosts[0].host, "eq.example.com");
        assert_eq!(hosts[0].username, "alice");
        assert_eq!(
            hosts[0].identity_file.as_deref(),
            Some("C:\\Users\\test\\.ssh\\key one")
        );
    }
}
