//! 同步密钥的交接：端到端加密的那把钥匙怎么到另一台电脑上去。
//!
//! 数据密钥（DK）加密代理密码，之后也加密上传到云端的东西。它只在用户的设备之间传递：
//!
//! - 每台设备有一对 X25519 密钥。私钥在系统钥匙串里，公钥交给服务器。
//! - 老设备批准新设备时，用新设备的公钥把 DK 包起来（ECDH + HKDF + AES-256-GCM），经服务器转交。
//! - 服务器只保管和转交包装，拆不开。
//! - 用户在两台设备上核对同一串 6 位数字：服务器要是把公钥换成自己的，数字就对不上。
//! - 所有设备都没了，用一次性的恢复码（Argon2id 派生）解开另一份包装。

use crate::vault::DataKey;
use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

const KEYCHAIN_ITEM: &str = "sync-device-key";
/// 恢复码的派生参数。故意比应用锁轻一点：恢复码本身有 128 位随机，不怕被猜。
const RECOVERY_PARAMS: (u32, u32, u32) = (64 * 1024, 2, 1);

fn random<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf
}

/// 这台设备的长期密钥对。第一次用的时候生成，之后一直在系统钥匙串里。
pub struct DeviceKey {
    secret: StaticSecret,
}

impl DeviceKey {
    pub fn load(dir: &std::path::Path) -> Result<Self> {
        if let Some(text) = crate::keychain::load(dir, KEYCHAIN_ITEM) {
            let bytes: [u8; 32] = B64
                .decode(text)
                .ok()
                .and_then(|b| b.try_into().ok())
                .context("钥匙串里的设备密钥坏了")?;
            return Ok(Self {
                secret: StaticSecret::from(bytes),
            });
        }
        let secret = StaticSecret::from(random::<32>());
        crate::keychain::save(dir, KEYCHAIN_ITEM, &B64.encode(secret.to_bytes()))
            .map_err(|e| anyhow!("设备密钥存不进系统钥匙串：{e}"))?;
        Ok(Self { secret })
    }

    pub fn public_b64(&self) -> String {
        B64.encode(PublicKey::from(&self.secret).as_bytes())
    }

    /// 拆开别人用我的公钥包的那一份。
    pub fn unseal(&self, ephemeral_b64: &str, box_b64: &str) -> Result<DataKey> {
        let their: [u8; 32] = B64
            .decode(ephemeral_b64)?
            .try_into()
            .map_err(|_| anyhow!("一次性公钥不是 32 字节"))?;
        let shared = self.secret.diffie_hellman(&PublicKey::from(their));
        let key = wrapping_key(
            shared.as_bytes(),
            &their,
            PublicKey::from(&self.secret).as_bytes(),
        )?;
        let plain = crate::vault::open_slices(&key, AAD, &B64.decode(box_b64)?)?;
        DataKey::try_from(plain).map_err(|_| anyhow!("包里装的不是一把密钥"))
    }
}

const AAD: &[u8] = b"enclave-sync-envelope-v1";

/// 包装用的一次性密钥。把两边的公钥一起算进去：换了收件人就得到另一把钥匙。
fn wrapping_key(shared: &[u8], ephemeral: &[u8; 32], recipient: &[u8; 32]) -> Result<DataKey> {
    let hk = hkdf::Hkdf::<Sha256>::new(
        Some(&[ephemeral.as_slice(), recipient.as_slice()].concat()),
        shared,
    );
    let mut out = [0u8; 32];
    hk.expand(b"enclave-sync-wrap-v1", &mut out)
        .map_err(|_| anyhow!("hkdf"))?;
    Ok(out)
}

/// 用某台设备的公钥把数据密钥包起来。返回（一次性公钥, 密文），两样都是 base64。
pub fn seal_for(recipient_public_b64: &str, dk: &DataKey) -> Result<(String, String)> {
    let recipient: [u8; 32] = B64
        .decode(recipient_public_b64)?
        .try_into()
        .map_err(|_| anyhow!("公钥不是 32 字节"))?;
    let ephemeral = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
    let ephemeral_pub = *PublicKey::from(&ephemeral).as_bytes();
    let shared = ephemeral.diffie_hellman(&PublicKey::from(recipient));
    let key = wrapping_key(shared.as_bytes(), &ephemeral_pub, &recipient)?;
    let sealed = crate::vault::seal_joined(&key, AAD, dk)?;
    Ok((B64.encode(ephemeral_pub), B64.encode(sealed)))
}

/* ── 恢复码 ───────────────────────────────────────────────────────
26 个字符的一次性码，写成 5 组：ENCLA-VE7Q2-... 用户抄下来或者存成文件。
它派生出一把钥匙，包住同一个数据密钥。所有设备都没了的时候用它。 */

/// 不含容易看混的字符（0/O、1/I/L）。
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

pub fn new_recovery_code() -> String {
    let raw: [u8; 20] = random();
    let letters: String = raw
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect();
    letters
        .as_bytes()
        .chunks(5)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

/// 用户抄下来的码：大小写、分组的横线都不计较。
pub fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn recovery_key(code: &str, salt: &[u8], params: (u32, u32, u32)) -> Result<DataKey> {
    let (m, t, p) = params;
    let cfg = Params::new(m, t, p, Some(32)).map_err(|e| anyhow!("argon2: {e}"))?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, cfg)
        .hash_password_into(normalize_code(code).as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("argon2: {e}"))?;
    Ok(out)
}

pub struct RecoveryBox {
    pub salt: String,
    pub params: String,
    pub sealed: String,
}

pub fn seal_recovery(code: &str, dk: &DataKey) -> Result<RecoveryBox> {
    let salt: [u8; 16] = random();
    let key = recovery_key(code, &salt, RECOVERY_PARAMS)?;
    let (m, t, p) = RECOVERY_PARAMS;
    Ok(RecoveryBox {
        salt: B64.encode(salt),
        params: format!("argon2id:{m}:{t}:{p}"),
        sealed: B64.encode(crate::vault::seal_joined(
            &key,
            b"enclave-sync-recovery-v1",
            dk,
        )?),
    })
}

pub fn open_recovery(code: &str, boxed: &RecoveryBox) -> Result<DataKey> {
    let mut parts = boxed.params.split(':');
    if parts.next() != Some("argon2id") {
        bail!("不认识的恢复码派生方式");
    }
    let mut num = || -> Result<u32> {
        parts
            .next()
            .and_then(|v| v.parse().ok())
            .context("派生参数不合法")
    };
    let (m, t, p) = (num()?, num()?, num()?);
    // 别让服务器用一个离谱的参数把客户端拖死。
    if !(8 * 1024..=512 * 1024).contains(&m) || !(1..=10).contains(&t) || !(1..=4).contains(&p) {
        bail!("派生参数超出范围");
    }
    let key = recovery_key(code, &B64.decode(&boxed.salt)?, (m, t, p))?;
    let plain = crate::vault::open_slices(
        &key,
        b"enclave-sync-recovery-v1",
        &B64.decode(&boxed.sealed)?,
    )
    .map_err(|_| anyhow!("恢复码不对"))?;
    DataKey::try_from(plain).map_err(|_| anyhow!("包里装的不是一把密钥"))
}

/// 新密钥的编号。换密钥时它跟着换，别的设备据此知道自己手里的那把过期了。
pub fn new_key_id() -> String {
    hex::encode(random::<8>())
}

/* ── 一个环境一把钥匙 ────────────────────────────────────────────
团队密钥（DK）只在所有者和管理员的电脑上。每个环境、以及"代理这一包"，
各自有一把随机的槽位钥匙（EK）：

  DK ──包住──> EK（所有者/管理员的电脑解得开）
  成员设备的公钥 ──包住──> EK（只发给被分配了这个环境的人）

环境和登录态都用 EK 加密。所以"没分配给你"不是"服务器不发给你"，
而是**密文给了你也解不开**。移除成员时只需要给他碰过的那几个槽位换 EK，
别的环境一个字节都不用动。 */

/// 槽位的名字：`env:<环境编号>`，或者放代理那一包的 `shared`。
pub fn env_slot(env_id: &str) -> String {
    format!("env:{env_id}")
}

pub const SHARED_SLOT: &str = "shared";

pub fn new_slot_key() -> DataKey {
    random::<32>()
}

/// 用团队密钥包住一把槽位钥匙。附加认证数据绑着槽位名和编号：
/// 服务器把 A 环境的那一份换成 B 的、或者拿旧编号冒充新的，都解不开。
fn slot_aad(slot: &str, key_id: &str) -> Vec<u8> {
    format!("enclave-sync-slot-v1:{slot}:{key_id}").into_bytes()
}

fn slot_wrapping_key(dk: &DataKey, slot: &str) -> Result<DataKey> {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(slot.as_bytes()), dk);
    let mut out = [0u8; 32];
    hk.expand(b"enclave-sync-slot-v1", &mut out)
        .map_err(|_| anyhow!("hkdf"))?;
    Ok(out)
}

pub fn seal_slot(dk: &DataKey, slot: &str, key_id: &str, ek: &DataKey) -> Result<String> {
    let key = slot_wrapping_key(dk, slot)?;
    Ok(B64.encode(crate::vault::seal_joined(
        &key,
        &slot_aad(slot, key_id),
        ek,
    )?))
}

pub fn open_slot(dk: &DataKey, slot: &str, key_id: &str, boxed: &str) -> Result<DataKey> {
    let key = slot_wrapping_key(dk, slot)?;
    let plain = crate::vault::open_slices(&key, &slot_aad(slot, key_id), &B64.decode(boxed)?)?;
    DataKey::try_from(plain).map_err(|_| anyhow!("包里装的不是一把钥匙"))
}

/// 用户在两台设备上核对的那 6 位数字。和服务器（Go）算的是同一件事。
pub fn pairing_digits(public_key_b64: &str) -> String {
    let sum = Sha256::digest(
        [
            b"enclave-sync-pairing-v1:".as_slice(),
            public_key_b64.as_bytes(),
        ]
        .concat(),
    );
    let n = (u32::from(sum[0]) << 16 | u32::from(sum[1]) << 8 | u32::from(sum[2])) % 1_000_000;
    format!("{n:06}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("enclave-sync-{}", hex::encode(random::<6>())));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_device_it_was_sealed_for_can_open_it() {
        let (a, b) = (temp(), temp());
        let old = DeviceKey::load(&a).unwrap();
        let new = DeviceKey::load(&b).unwrap();
        let dk: DataKey = random();

        let (eph, sealed) = seal_for(&new.public_b64(), &dk).unwrap();
        assert_eq!(new.unseal(&eph, &sealed).unwrap(), dk);
        // 包给新设备的，老设备自己拆不开。
        assert!(old.unseal(&eph, &sealed).is_err());
        // 换掉一次性公钥、改一个字节，都拆不开。
        let (other_eph, _) = seal_for(&new.public_b64(), &dk).unwrap();
        assert!(new.unseal(&other_eph, &sealed).is_err());
        let mut bent = B64.decode(&sealed).unwrap();
        bent[0] ^= 1;
        assert!(new.unseal(&eph, &B64.encode(bent)).is_err());
        // 同一台设备重启后还是同一对钥匙。
        assert_eq!(DeviceKey::load(&b).unwrap().public_b64(), new.public_b64());

        for dir in [&a, &b] {
            crate::keychain::clear(dir, KEYCHAIN_ITEM);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_substituted_public_key_shows_up_as_different_digits() {
        let (a, b) = (temp(), temp());
        let mine = DeviceKey::load(&a).unwrap();
        let attacker = DeviceKey::load(&b).unwrap();
        let digits = pairing_digits(&mine.public_b64());
        assert_eq!(digits.len(), 6);
        assert!(digits.bytes().all(|c| c.is_ascii_digit()));
        assert_eq!(digits, pairing_digits(&mine.public_b64()));
        assert_ne!(digits, pairing_digits(&attacker.public_b64()));
        // 和服务器那边算的必须一模一样（Go 里有同名的函数和同一条测试向量）。
        assert_eq!(
            pairing_digits("MCowBQYDK2VuAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE="),
            crate::sync::pairing_digits(
                "MCowBQYDK2VuAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE="
            )
        );
        for dir in [&a, &b] {
            crate::keychain::clear(dir, KEYCHAIN_ITEM);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn the_recovery_code_is_readable_and_only_it_opens_the_box() {
        let code = new_recovery_code();
        assert_eq!(code.len(), 20 + 3, "20 个字符分成 4 组");
        assert!(
            !code.contains(['0', 'O', '1', 'I', 'L']),
            "不放容易看混的字符：{code}"
        );
        assert_ne!(code, new_recovery_code());

        let dk: DataKey = random();
        let boxed = seal_recovery(&code, &dk).unwrap();
        // 抄下来的时候大小写、横线都不计较。
        assert_eq!(open_recovery(&code.to_lowercase(), &boxed).unwrap(), dk);
        assert_eq!(open_recovery(&code.replace('-', " "), &boxed).unwrap(), dk);
        assert!(open_recovery(&new_recovery_code(), &boxed).is_err());
        // 服务器给一个离谱的派生参数，客户端不跟着算。
        let mut evil = RecoveryBox {
            salt: boxed.salt.clone(),
            params: "argon2id:4194304:10:4".into(),
            sealed: boxed.sealed.clone(),
        };
        assert!(open_recovery(&code, &evil).is_err());
        evil.params = "pbkdf2:1:1:1".into();
        assert!(open_recovery(&code, &evil).is_err());
    }
}

/* ── 环境和代理：加密之后才上云 ──────────────────────────────────
每一条用数据密钥派生出的子密钥单独加密，附加认证数据里带着账号、类型、编号和版本：
服务器把 A 的密文换成 B 的、或者拿旧版本冒充新版本，客户端都解不开。 */

/// 一条文档的加密钥匙。同一把数据密钥，不同的条目得到不同的子密钥。
fn doc_key(dk: &DataKey, kind: &str, id: &str) -> Result<DataKey> {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(format!("{kind}/{id}").as_bytes()), dk);
    let mut out = [0u8; 32];
    hk.expand(b"enclave-sync-doc-v1", &mut out)
        .map_err(|_| anyhow!("hkdf"))?;
    Ok(out)
}

fn doc_aad(key_id: &str, kind: &str, id: &str, version: i64) -> Vec<u8> {
    format!("enclave-sync-doc-v1:{key_id}:{kind}:{id}:{version}").into_bytes()
}

pub fn seal_doc(
    dk: &DataKey,
    key_id: &str,
    kind: &str,
    id: &str,
    version: i64,
    doc: &[u8],
) -> Result<String> {
    let key = doc_key(dk, kind, id)?;
    Ok(B64.encode(crate::vault::seal_joined(
        &key,
        &doc_aad(key_id, kind, id, version),
        doc,
    )?))
}

pub fn open_doc(
    dk: &DataKey,
    key_id: &str,
    kind: &str,
    id: &str,
    version: i64,
    boxed: &str,
) -> Result<Vec<u8>> {
    let key = doc_key(dk, kind, id)?;
    crate::vault::open_slices(
        &key,
        &doc_aad(key_id, kind, id, version),
        &B64.decode(boxed)?,
    )
}

/// 登录态那一包的钥匙和附加认证数据。和配置那一份分开：同一个环境的两样东西互相换不了位置。
fn blob_key(dk: &DataKey, env_id: &str) -> Result<DataKey> {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(env_id.as_bytes()), dk);
    let mut out = [0u8; 32];
    hk.expand(b"enclave-sync-cookies-v1", &mut out)
        .map_err(|_| anyhow!("hkdf"))?;
    Ok(out)
}

fn blob_aad(key_id: &str, env_id: &str, version: i64) -> Vec<u8> {
    format!("enclave-sync-cookies-v1:{key_id}:{env_id}:{version}").into_bytes()
}

pub fn seal_blob(
    dk: &DataKey,
    key_id: &str,
    env_id: &str,
    version: i64,
    packed: &[u8],
) -> Result<Vec<u8>> {
    crate::vault::seal_joined(
        &blob_key(dk, env_id)?,
        &blob_aad(key_id, env_id, version),
        packed,
    )
}

pub fn open_blob(
    dk: &DataKey,
    key_id: &str,
    env_id: &str,
    version: i64,
    sealed: &[u8],
) -> Result<Vec<u8>> {
    crate::vault::open_slices(
        &blob_key(dk, env_id)?,
        &blob_aad(key_id, env_id, version),
        sealed,
    )
}

#[cfg(test)]
mod blob_tests {
    use super::*;

    #[test]
    fn a_cookie_jar_is_pinned_to_its_environment_and_version() {
        let dk: DataKey = random();
        let packed = b"zlib-packed-cookies";
        let sealed = seal_blob(&dk, "k1", "env_a", 5, packed).unwrap();
        assert_eq!(open_blob(&dk, "k1", "env_a", 5, &sealed).unwrap(), packed);
        // 换环境、换版本、换密钥编号、换密钥，都解不开。
        assert!(open_blob(&dk, "k1", "env_b", 5, &sealed).is_err());
        assert!(open_blob(&dk, "k1", "env_a", 4, &sealed).is_err());
        assert!(open_blob(&dk, "k2", "env_a", 5, &sealed).is_err());
        assert!(open_blob(&random(), "k1", "env_a", 5, &sealed).is_err());
        // 和同一个环境的配置密文也换不了位置：两者的子密钥不同。
        let doc = seal_doc(&dk, "k1", "environment", "env_a", 5, packed).unwrap();
        assert!(open_blob(&dk, "k1", "env_a", 5, &B64.decode(doc).unwrap()).is_err());
    }
}

#[cfg(test)]
mod doc_tests {
    use super::*;

    #[test]
    fn a_document_is_pinned_to_its_account_slot_and_version() {
        let dk: DataKey = random();
        let plain = br#"{"id":"env_a","name":"shop-us-01"}"#;
        let sealed = seal_doc(&dk, "k1", "environment", "env_a", 3, plain).unwrap();
        assert!(!sealed.contains("shop-us-01"));
        assert_eq!(
            open_doc(&dk, "k1", "environment", "env_a", 3, &sealed).unwrap(),
            plain
        );

        // 服务器把它挪到别的编号、别的类型、别的版本、别的密钥下，都解不开。
        assert!(open_doc(&dk, "k1", "environment", "env_b", 3, &sealed).is_err());
        assert!(open_doc(&dk, "k1", "proxy", "env_a", 3, &sealed).is_err());
        assert!(open_doc(&dk, "k1", "environment", "env_a", 2, &sealed).is_err());
        assert!(open_doc(&dk, "k2", "environment", "env_a", 3, &sealed).is_err());
        assert!(open_doc(&random(), "k1", "environment", "env_a", 3, &sealed).is_err());
        // 同一把数据密钥下，两条文档用的不是同一把子密钥。
        let other = seal_doc(&dk, "k1", "environment", "env_b", 3, plain).unwrap();
        assert!(open_doc(&dk, "k1", "environment", "env_a", 3, &other).is_err());
    }
}

#[cfg(test)]
mod slot_tests {
    use super::*;

    /// 槽位钥匙是"没分配给你就解不开"的全部依据，所以这里要盯死三件事：
    /// 包对了能解开、换个槽位或编号就解不开、拿到别人的密文也没用。
    #[test]
    fn a_slot_key_only_opens_under_its_own_name_and_id() {
        let dk: DataKey = random();
        let ek = new_slot_key();
        let slot = env_slot("env_a");
        let boxed = seal_slot(&dk, &slot, "k1", &ek).unwrap();

        assert_eq!(open_slot(&dk, &slot, "k1", &boxed).unwrap(), ek);
        // 服务器把 A 环境那一份挪到 B 环境名下、或者拿旧编号冒充新的，都解不开。
        assert!(open_slot(&dk, &env_slot("env_b"), "k1", &boxed).is_err());
        assert!(open_slot(&dk, &slot, "k2", &boxed).is_err());
        assert!(open_slot(&dk, SHARED_SLOT, "k1", &boxed).is_err());
        // 别的团队的密钥当然也解不开。
        assert!(open_slot(&random(), &slot, "k1", &boxed).is_err());
        // 包里装的是钥匙本身，不是别的什么。
        assert!(!boxed.contains(&B64.encode(ek)));
    }

    /// 操作员手里只有分给他那个环境的钥匙。拿到别的环境的密文，解不开。
    #[test]
    fn an_operator_holding_one_slot_key_cannot_read_another_environment() {
        let mine = new_slot_key();
        let theirs = new_slot_key();
        let secret = br#"{"id":"env_secret","name":"the boss shop"}"#;

        let sealed = seal_doc(&theirs, "k1", "environment", "env_secret", 1, secret).unwrap();
        assert!(open_doc(&mine, "k1", "environment", "env_secret", 1, &sealed).is_err());
        // 登录态同理。
        let jar = seal_blob(&theirs, "k1", "env_secret", 1, b"cookies").unwrap();
        assert!(open_blob(&mine, "k1", "env_secret", 1, &jar).is_err());
    }

    /// 换钥匙之后，旧钥匙对新密文无效——这是移除成员之后那句承诺的依据。
    #[test]
    fn a_rotated_slot_locks_out_the_old_key() {
        let old = new_slot_key();
        let new = new_slot_key();
        let after = seal_doc(&new, "k2", "environment", "env_a", 2, b"rotated").unwrap();
        assert!(open_doc(&old, "k2", "environment", "env_a", 2, &after).is_err());
        assert_eq!(
            open_doc(&new, "k2", "environment", "env_a", 2, &after).unwrap(),
            b"rotated"
        );
    }
}
