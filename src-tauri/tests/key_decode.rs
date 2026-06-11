//! Decodes the locally generated test keys the way session/auth.rs does —
//! pins down key-format issues without driving the GUI.

#[test]
fn decode_generated_test_keys() {
    let dir = std::path::PathBuf::from(std::env::var("TEMP").unwrap()).join("ssh-test-keys");
    if !dir.exists() {
        eprintln!("skipping: {dir:?} missing (generate with ssh-keygen first)");
        return;
    }

    let plain = std::fs::read_to_string(dir.join("id_ed25519")).unwrap();
    russh::keys::decode_secret_key(&plain, None).expect("plain ed25519 should decode");

    let enc = std::fs::read_to_string(dir.join("id_enc")).unwrap();
    russh::keys::decode_secret_key(&enc, Some("kppass")).expect("encrypted key should decode");

    // Wrong passphrase must fail, not panic.
    assert!(russh::keys::decode_secret_key(&enc, Some("wrong")).is_err());
}
