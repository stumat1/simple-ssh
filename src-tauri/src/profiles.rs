//! Persists saved connection profiles and a capped most-recent-used list to a
//! JSON file (same schema as the Electron build's profiles.json). Secrets are
//! never stored here — only references (host/port/user/keyPath); passwords and
//! passphrases live in the secret store.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::{AuthMethod, Profile, RecentConnection};

const MAX_RECENTS: usize = 8;

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistShape {
    #[serde(default)]
    profiles: Vec<Profile>,
    #[serde(default)]
    recents: Vec<RecentConnection>,
}

fn recent_key(host: &str, port: u16, username: &str) -> String {
    format!("{username}@{host}:{port}")
}

pub struct ProfileStore {
    file_path: PathBuf,
    data: PersistShape,
}

impl ProfileStore {
    pub fn new(file_path: PathBuf) -> Self {
        // Corrupt/unreadable store — start empty rather than crash.
        let data = std::fs::read_to_string(&file_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self { file_path, data }
    }

    fn persist(&self) {
        if let Some(dir) = self.file_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = std::fs::write(&self.file_path, json);
        }
    }

    pub fn list(&self) -> Vec<Profile> {
        self.data.profiles.clone()
    }

    /// Create or update a profile (upsert by id). Returns the stored profile.
    pub fn save(&mut self, input: Profile) -> Profile {
        let profile = Profile {
            id: if input.id.is_empty() {
                Uuid::new_v4().to_string()
            } else {
                input.id.clone()
            },
            auth: input.auth.sanitized(),
            ..input
        };
        match self.data.profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile.clone(),
            None => self.data.profiles.push(profile.clone()),
        }
        self.persist();
        profile
    }

    pub fn delete(&mut self, id: &str) {
        let before = self.data.profiles.len();
        self.data.profiles.retain(|p| p.id != id);
        if self.data.profiles.len() != before {
            self.persist();
        }
    }

    pub fn recents(&self) -> Vec<RecentConnection> {
        self.data.recents.clone()
    }

    /// Record a successful connection at the head of the recents list (deduped).
    pub fn record_recent(&mut self, host: &str, port: u16, username: &str, auth: &AuthMethod) {
        let key = recent_key(host, port, username);
        self.data
            .recents
            .retain(|r| recent_key(&r.host, r.port, &r.username) != key);
        let last_used = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.data.recents.insert(
            0,
            RecentConnection {
                host: host.to_string(),
                port,
                username: username.to_string(),
                auth: auth.sanitized(),
                last_used,
            },
        );
        self.data.recents.truncate(MAX_RECENTS);
        self.persist();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ProfileStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path().join("profiles.json"));
        (dir, store)
    }

    #[test]
    fn parses_electron_profiles_json() {
        // Fixture matching the shape the Electron ProfileStore writes.
        let json = r#"{
          "profiles": [
            {
              "id": "8d0f4a3e-1111-2222-3333-444455556666",
              "name": "My Server",
              "host": "example.com",
              "port": 22,
              "username": "alice",
              "auth": { "kind": "key", "keyPath": "C:\\keys\\id_ed25519" },
              "saveSecret": true
            }
          ],
          "recents": [
            {
              "host": "example.com",
              "port": 22,
              "username": "alice",
              "auth": { "kind": "password" },
              "lastUsed": 1718000000000
            }
          ]
        }"#;
        let parsed: PersistShape = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.profiles.len(), 1);
        assert!(matches!(
            &parsed.profiles[0].auth,
            AuthMethod::Key { key_path, passphrase: None } if key_path == "C:\\keys\\id_ed25519"
        ));
        assert_eq!(parsed.recents[0].last_used, 1_718_000_000_000);

        // Round-trip: serialization keeps the camelCase field names.
        let out = serde_json::to_string(&parsed).unwrap();
        assert!(out.contains("\"keyPath\""));
        assert!(out.contains("\"saveSecret\""));
        assert!(out.contains("\"lastUsed\""));
        assert!(out.contains("\"kind\":\"password\""));
    }

    #[test]
    fn save_assigns_id_and_strips_secrets() {
        let (_dir, mut store) = store();
        let saved = store.save(Profile {
            id: String::new(),
            name: "Test".into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth: AuthMethod::Password {
                password: Some("hunter2".into()),
            },
            save_secret: false,
        });
        assert!(!saved.id.is_empty());
        assert!(matches!(saved.auth, AuthMethod::Password { password: None }));
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn recents_dedupe_and_cap() {
        let (_dir, mut store) = store();
        for i in 0..10 {
            store.record_recent(&format!("host{i}"), 22, "u", &AuthMethod::Agent);
        }
        // Re-record host5 — moves to the head, no duplicate.
        store.record_recent("host5", 22, "u", &AuthMethod::Agent);
        let recents = store.recents();
        assert_eq!(recents.len(), MAX_RECENTS);
        assert_eq!(recents[0].host, "host5");
        assert_eq!(
            recents.iter().filter(|r| r.host == "host5").count(),
            1
        );
    }
}
