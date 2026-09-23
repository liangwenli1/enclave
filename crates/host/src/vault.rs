//! 数据密钥和它保护的东西。
//!
//! 一把随机的 256 位数据密钥（DK）加密本机存着的代理密码，之后也用它加密同步到云端的数据。
//! 平时它放在系统钥匙串里，由操作系统账号保护——用户不用设口令、不用记口令。
//!
//! 「应用锁」是可选的：给共用一台电脑的人用。开了之后 DK 不再放钥匙串，
//! 而是用口令（Argon2id）包一层存在 `lock.json` 里，每次打开工作台要输口令才解得开。
//!
//! 代理密码只进不出：页面可以写、可以删、可以问"有没有"，读不回明文。要带走只能经导出口令加密后带走。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const KEYCHAIN_ITEM: &str = "data-key";

pub type DataKey = [u8; 32];

fn random<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf
}

/// AES-256-GCM。`aad` 把密文钉在它该在的位置上：换个位置（比如把 A 的密码挪给 B）就解不开。
pub fn seal(key: &DataKey, aad: &[u8], plain: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let nonce: [u8; 12] = random();
    let cipher = Aes256Gcm::new(key.into());
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload { msg: plain, aad },
        )
        .map_err(|_| anyhow!("encrypt"))?;
    Ok((nonce.to_vec(), ct))
}

pub fn open(key: &DataKey, aad: &[u8], nonce: &[u8], ct: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != 12 {
        bail!("bad nonce");
    }
    Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(nonce),
            aes_gcm::aead::Payload { msg: ct, aad },
        )
        .map_err(|_| anyhow!("解不开：密钥不对，或者数据被动过"))
}

/// nonce 和密文连在一起的一小段，方便当成一个 base64 字段存和传。
pub fn seal_joined(key: &DataKey, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let (nonce, ct) = seal(key, aad, plain)?;
    Ok([nonce, ct].concat())
}

pub fn open_slices(key: &DataKey, aad: &[u8], joined: &[u8]) -> Result<Vec<u8>> {
    if joined.len() < 13 {
        bail!("密文太短");
    }
    let (nonce, ct) = joined.split_at(12);
    open(key, aad, nonce, ct)
}

/// 应用锁：DK 用口令包一层之后的样子。
#[derive(Serialize, Deserialize)]
struct LockFile {
    v: u32,
    kdf: String,
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
    wrapped: String,
}

fn stretch(passphrase: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> Result<DataKey> {
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| anyhow!("argon2: {e}"))?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("argon2: {e}"))?;
    Ok(out)
}

pub struct Vault {
    dir: PathBuf,
    /// 解开了的数据密钥。开着应用锁、还没输口令时是 None。
    key: Option<DataKey>,
}

impl Vault {
    fn lock_path(dir: &Path) -> PathBuf {
        dir.join("lock.json")
    }

    /// 启动时：开着应用锁就保持锁着；没开就从钥匙串取，第一次用就生成一把。
    pub fn load(dir: &Path) -> Result<Self> {
        if Self::lock_path(dir).exists() {
            return Ok(Self {
                dir: dir.into(),
                key: None,
            });
        }
        let key = match crate::keychain::load(dir, KEYCHAIN_ITEM) {
            Some(text) => B64
                .decode(text)
                .ok()
                .and_then(|b| DataKey::try_from(b).ok())
                .context("钥匙串里的数据密钥坏了")?,
            None => {
                let key: DataKey = random();
                crate::keychain::save(dir, KEYCHAIN_ITEM, &B64.encode(key))
                    .map_err(|e| anyhow!("数据密钥存不进系统钥匙串：{e}"))?;
                key
            }
        };
        Ok(Self {
            dir: dir.into(),
            key: Some(key),
        })
    }

    pub fn app_lock(&self) -> bool {
        Self::lock_path(&self.dir).exists()
    }

    pub fn unlocked(&self) -> bool {
        self.key.is_some()
    }

    pub fn key(&self) -> Option<&DataKey> {
        self.key.as_ref()
    }

    pub fn unlock(&mut self, passphrase: &str) -> Result<()> {
        let file: LockFile = serde_json::from_slice(&std::fs::read(Self::lock_path(&self.dir))?)?;
        let kek = stretch(
            passphrase,
            &B64.decode(&file.salt)?,
            file.m_kib,
            file.t,
            file.p,
        )?;
        let dk = open(
            &kek,
            b"enclave-app-lock-v1",
            &B64.decode(&file.nonce)?,
            &B64.decode(&file.wrapped)?,
        )
        .map_err(|_| anyhow!("口令不对"))?;
        self.key = Some(DataKey::try_from(dk).map_err(|_| anyhow!("lock.json 坏了"))?);
        Ok(())
    }

    /// 锁上：把内存里的密钥丢掉。只有开着应用锁才有意义。
    pub fn lock(&mut self) {
        if self.app_lock() {
            self.key = None;
        }
    }

    /// 开应用锁（或者换口令）：DK 用口令包好写进 lock.json，然后从钥匙串里拿走。
    pub fn enable_app_lock(&mut self, passphrase: &str) -> Result<()> {
        let dk = self.key.context("先解锁")?;
        if passphrase.chars().count() < 8 {
            bail!("口令至少 8 个字符");
        }
        // 64 MiB、3 轮：普通电脑上大约半秒，够慢又不烦人。
        let (m_kib, t, p) = (64 * 1024, 3, 1);
        let salt: [u8; 16] = random();
        let kek = stretch(passphrase, &salt, m_kib, t, p)?;
        let (nonce, wrapped) = seal(&kek, b"enclave-app-lock-v1", &dk)?;
        let file = LockFile {
            v: 1,
            kdf: "argon2id".into(),
            m_kib,
            t,
            p,
            salt: B64.encode(salt),
            nonce: B64.encode(nonce),
            wrapped: B64.encode(wrapped),
        };
        std::fs::write(
            Self::lock_path(&self.dir),
            serde_json::to_vec_pretty(&file)?,
        )?;
        crate::keychain::clear(&self.dir, KEYCHAIN_ITEM);
        Ok(())
    }

    /// 关应用锁：DK 放回钥匙串。
    pub fn disable_app_lock(&mut self) -> Result<()> {
        let dk = self.key.context("先解锁")?;
        crate::keychain::save(&self.dir, KEYCHAIN_ITEM, &B64.encode(dk))
            .map_err(|e| anyhow!("数据密钥存不进系统钥匙串：{e}"))?;
        std::fs::remove_file(Self::lock_path(&self.dir))?;
        Ok(())
    }

    /// 换成另一台设备交过来的那把密钥（或者恢复码解出来的那把）。
    /// 调用方要先把本机已经加密的东西用旧钥匙解出来、用新钥匙重新加密，否则它们就打不开了。
    pub fn replace_key(&mut self, key: DataKey) -> Result<()> {
        if self.app_lock() {
            bail!("开着应用锁时先解锁再换密钥");
        }
        crate::keychain::save(&self.dir, KEYCHAIN_ITEM, &B64.encode(key))
            .map_err(|e| anyhow!("数据密钥存不进系统钥匙串：{e}"))?;
        self.key = Some(key);
        Ok(())
    }

    /// 忘了口令：换一把新的数据密钥。旧密钥加密的东西（保存过的代理密码）就此作废，调用方要一起清掉。
    pub fn reset(&mut self) -> Result<()> {
        let _ = std::fs::remove_file(Self::lock_path(&self.dir));
        let key: DataKey = random();
        crate::keychain::save(&self.dir, KEYCHAIN_ITEM, &B64.encode(key))
            .map_err(|e| anyhow!("数据密钥存不进系统钥匙串：{e}"))?;
        self.key = Some(key);
        Ok(())
    }
}

/* ── 带走密码：用导出口令单独加密 ─────────────────────────────────────
格式和环境包（.enclave.json）里的 secrets 一致：PBKDF2-SHA256 → AES-256-GCM，
这样以前导出的包照样导得进来。 */

const EXPORT_ITERATIONS: u32 = 310_000;

#[derive(Serialize, Deserialize, Debug)]
pub struct SealedSecrets {
    pub alg: String,
    pub iterations: u32,
    pub salt: String,
    pub iv: String,
    pub ct: String,
}

fn export_key(passphrase: &str, salt: &[u8], iterations: u32) -> DataKey {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, iterations, &mut key);
    key
}

pub fn seal_export(
    passphrase: &str,
    secrets: &std::collections::BTreeMap<String, String>,
) -> Result<SealedSecrets> {
    let salt: [u8; 16] = random();
    let key = export_key(passphrase, &salt, EXPORT_ITERATIONS);
    let (iv, ct) = seal(&key, b"", serde_json::to_string(secrets)?.as_bytes())?;
    Ok(SealedSecrets {
        alg: "PBKDF2-SHA256/AES-GCM".into(),
        iterations: EXPORT_ITERATIONS,
        salt: B64.encode(salt),
        iv: B64.encode(iv),
        ct: B64.encode(ct),
    })
}

pub fn open_export(
    passphrase: &str,
    sealed: &SealedSecrets,
) -> Result<std::collections::BTreeMap<String, String>> {
    if sealed.alg != "PBKDF2-SHA256/AES-GCM" || !(100_000..=5_000_000).contains(&sealed.iterations)
    {
        bail!("不认识的加密方式");
    }
    let key = export_key(passphrase, &B64.decode(&sealed.salt)?, sealed.iterations);
    let plain = open(
        &key,
        b"",
        &B64.decode(&sealed.iv)?,
        &B64.decode(&sealed.ct)?,
    )
    .map_err(|_| anyhow!("导出口令不对"))?;
    Ok(serde_json::from_slice(&plain)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("enclave-vault-{}", hex::encode(random::<6>())));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ciphertext_is_pinned_to_where_it_belongs() {
        let key: DataKey = random();
        let (nonce, ct) = seal(&key, b"secret:proxy:a", b"hunter2").unwrap();
        assert_eq!(
            open(&key, b"secret:proxy:a", &nonce, &ct).unwrap(),
            b"hunter2"
        );
        // 挪到别的条目下、换一把钥匙、改一个字节，都解不开。
        assert!(open(&key, b"secret:proxy:b", &nonce, &ct).is_err());
        assert!(open(&random(), b"secret:proxy:a", &nonce, &ct).is_err());
        let mut bent = ct.clone();
        bent[0] ^= 1;
        assert!(open(&key, b"secret:proxy:a", &nonce, &bent).is_err());
    }

    #[test]
    fn without_app_lock_the_key_just_works_and_survives_restarts() {
        let dir = temp();
        let first = Vault::load(&dir).unwrap();
        assert!(first.unlocked() && !first.app_lock());
        let again = Vault::load(&dir).unwrap();
        assert_eq!(
            first.key(),
            again.key(),
            "同一台电脑上每次启动拿到的是同一把钥匙"
        );
        crate::keychain::clear(&dir, KEYCHAIN_ITEM);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_lock_wraps_the_same_key_and_takes_it_out_of_the_keychain() {
        let dir = temp();
        let mut v = Vault::load(&dir).unwrap();
        let dk = *v.key().unwrap();
        assert!(v.enable_app_lock("short").is_err());
        v.enable_app_lock("correct horse battery").unwrap();
        assert!(
            crate::keychain::load(&dir, KEYCHAIN_ITEM).is_none(),
            "开了应用锁，钥匙串里不该再有明文钥匙"
        );

        // 重启：锁着；口令错不行；口令对拿回的是同一把钥匙（之前加密的东西还解得开）。
        let mut restarted = Vault::load(&dir).unwrap();
        assert!(restarted.app_lock() && !restarted.unlocked());
        assert!(restarted.unlock("wrong horse").is_err());
        assert!(!restarted.unlocked());
        restarted.unlock("correct horse battery").unwrap();
        assert_eq!(restarted.key(), Some(&dk));
        restarted.lock();
        assert!(!restarted.unlocked());

        // 关掉应用锁：钥匙回到钥匙串，下次启动不用输口令。
        restarted.unlock("correct horse battery").unwrap();
        restarted.disable_app_lock().unwrap();
        let plain = Vault::load(&dir).unwrap();
        assert!(plain.unlocked() && !plain.app_lock());
        assert_eq!(plain.key(), Some(&dk));

        // 忘了口令：换新钥匙，旧的作废。
        let mut lost = Vault::load(&dir).unwrap();
        lost.enable_app_lock("another long phrase").unwrap();
        let mut locked = Vault::load(&dir).unwrap();
        locked.reset().unwrap();
        assert!(locked.unlocked() && !locked.app_lock());
        assert_ne!(locked.key(), Some(&dk));
        crate::keychain::clear(&dir, KEYCHAIN_ITEM);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exported_secrets_open_only_with_the_export_passphrase() {
        let mut secrets = std::collections::BTreeMap::new();
        secrets.insert("proxy:prx_1".to_string(), "p@ss 密码".to_string());
        let sealed = seal_export("export-phrase", &secrets).unwrap();
        assert!(!serde_json::to_string(&sealed).unwrap().contains("p@ss"));
        assert_eq!(open_export("export-phrase", &sealed).unwrap(), secrets);
        assert!(open_export("other", &sealed).is_err());
    }

    #[test]
    fn opens_a_package_sealed_by_webcrypto() {
        // 这一份密文是用浏览器那套 WebCrypto（PBKDF2-SHA256 310000 轮 → AES-GCM，口令 "legacy"）实际算出来的，
        // 不是用这里的代码自己加密再自己解：它钉住的是"和页面里导出的包格式一致"。
        let sealed = SealedSecrets {
            alg: "PBKDF2-SHA256/AES-GCM".into(),
            iterations: 310_000,
            salt: "BwcHBwcHBwcHBwcHBwcHBw==".into(),
            iv: "CQkJCQkJCQkJCQkJ".into(),
            ct: "cgWKn+zH7+gtkhf1/qVLu5CEiy5EqVq8FZQW2XmvsairhoSkGz8P".into(),
        };
        assert_eq!(
            open_export("legacy", &sealed).unwrap()["proxy:prx_old"],
            "abc"
        );
        assert!(open_export("Legacy", &sealed).is_err());
    }
}
