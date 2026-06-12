//! Stores secrets (passwords/passphrases) in the OS keystore via the keyring
//! crate (Windows Credential Manager on Windows). Plaintext never crosses to
//! the renderer — only presence checks and forget; decrypted values are
//! injected into connect requests backend-side.
//!
//! Ids use the same scheme as the Electron build: `pw:user@host:port` for
//! passwords, `pp:<keyPath>` for key passphrases. (Old DPAPI-encrypted
//! secrets.json files are intentionally not migrated.)

const SERVICE: &str = "simple-ssh";

/// Stable id for a stored password: pw:user@host:port.
pub fn password_id(host: &str, port: u16, username: &str) -> String {
    format!("pw:{username}@{host}:{port}")
}

/// Stable id for a stored key passphrase, keyed by key path.
pub fn passphrase_id(key_path: &str) -> String {
    format!("pp:{key_path}")
}

fn entry(id: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE, id)
}

pub struct SecretStore;

impl SecretStore {
    pub fn has(&self, id: &str) -> bool {
        entry(id).and_then(|e| e.get_password()).is_ok()
    }

    /// Persist a secret. Returns false if the OS keystore rejected it.
    pub fn set(&self, id: &str, plaintext: &str) -> bool {
        entry(id).and_then(|e| e.set_password(plaintext)).is_ok()
    }

    /// Fetch a stored secret, or None if absent/unavailable.
    pub fn get(&self, id: &str) -> Option<String> {
        entry(id).and_then(|e| e.get_password()).ok()
    }

    pub fn delete(&self, id: &str) {
        let _ = entry(id).and_then(|e| e.delete_credential());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_schemes_match_electron() {
        assert_eq!(password_id("example.com", 22, "alice"), "pw:alice@example.com:22");
        assert_eq!(passphrase_id("C:\\keys\\id_ed25519"), "pp:C:\\keys\\id_ed25519");
    }
}
