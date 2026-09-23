//! 本机保密存储。Windows 用凭据管理器，macOS 用钥匙串：由操作系统账号保护，不需要用户再记一个口令。
//! 其余系统只用于开发和测试，放在数据目录里一个仅本人可读的文件。
//!
//! 放在这里的两样东西：和服务器说话用的设备令牌、加密本机数据和云端数据用的数据密钥。

use std::path::Path;

#[cfg(any(windows, target_os = "macos"))]
mod imp {
    use std::path::Path;

    const SERVICE: &str = "com.enclave.workbench";

    fn entry(name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
    }

    pub fn save(_dir: &Path, name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn load(_dir: &Path, name: &str) -> Option<String> {
        entry(name)
            .ok()?
            .get_password()
            .ok()
            .filter(|t| !t.is_empty())
    }

    pub fn clear(_dir: &Path, name: &str) {
        if let Ok(e) = entry(name) {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use std::path::{Path, PathBuf};

    fn file(dir: &Path, name: &str) -> PathBuf {
        dir.join(format!("{name}.secret"))
    }

    pub fn save(dir: &Path, name: &str, value: &str) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let path = file(dir, name);
        let _ = std::fs::remove_file(&path);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .and_then(|mut f| f.write_all(value.as_bytes()))
            .map_err(|e| e.to_string())
    }

    pub fn load(dir: &Path, name: &str) -> Option<String> {
        std::fs::read_to_string(file(dir, name))
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
    }

    pub fn clear(dir: &Path, name: &str) {
        let _ = std::fs::remove_file(file(dir, name));
    }
}

/// 名字只许小写字母和连字符：它在非桌面系统上会变成文件名。
fn ok(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

pub fn save(dir: &Path, name: &str, value: &str) -> Result<(), String> {
    if !ok(name) {
        return Err("bad keychain item name".into());
    }
    imp::save(dir, name, value)
}

pub fn load(dir: &Path, name: &str) -> Option<String> {
    ok(name).then(|| imp::load(dir, name)).flatten()
}

pub fn clear(dir: &Path, name: &str) {
    if ok(name) {
        imp::clear(dir, name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_round_trip_and_do_not_collide() {
        // 在 Windows / macOS 的 CI 上，这一条测的就是真的系统钥匙串。
        let dir = std::env::temp_dir().join(format!("enclave-kc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["test-item-a", "test-item-b"] {
            clear(&dir, name);
            assert_eq!(load(&dir, name), None);
        }
        save(&dir, "test-item-a", "one").unwrap();
        save(&dir, "test-item-a", "two").unwrap();
        save(&dir, "test-item-b", "other").unwrap();
        assert_eq!(load(&dir, "test-item-a").as_deref(), Some("two"));
        assert_eq!(load(&dir, "test-item-b").as_deref(), Some("other"));
        clear(&dir, "test-item-a");
        assert_eq!(load(&dir, "test-item-a"), None);
        assert_eq!(load(&dir, "test-item-b").as_deref(), Some("other"));
        clear(&dir, "test-item-b");
        assert!(save(&dir, "../escape", "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
