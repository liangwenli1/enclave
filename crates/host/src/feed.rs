//! 厂商远程上架的内核清单。
//!
//! 清单决定 Host 去哪里下载、下载回来执行什么，所以**只认签名**：
//!   k1.<base64url(payload)>.<base64url(ed25519 签名)>
//! 签的是 "enclave-kernels-v1." + body。验签用的公钥编译在这里，和工作台验许可证的是同一把；
//! 工作台只是把这段文字原样递过来，它说什么都不算数。
//!
//! 验过签还要再过两道：下载地址必须在上游发布目录之下，新清单不能比已经接受过的旧。

use crate::kernel::KernelRecord;
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

/// 厂商公钥（32 字节 raw，base64url）。必须和 src/lib/license/public-key.ts 里的一致，
/// 有测试盯着。正式部署换钥匙时两处一起换。
pub const VENDOR_PUBLIC_KEY: &str = "dJpAOBHjnTuXrsDbZWiHngIBMlvsFEIWl1wRP3-visM";

const SIGN_DOMAIN: &str = "enclave-kernels-v1.";
/// 只从上游项目的 GitHub Release 下载内核。
pub const UPSTREAM_PREFIX: &str =
    "https://github.com/adryfish/fingerprint-chromium/releases/download/";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelList {
    pub v: u32,
    pub issued_at: u64,
    pub kernels: Vec<KernelRecord>,
}

pub fn vendor_key() -> Result<VerifyingKey> {
    let raw = URL_SAFE_NO_PAD.decode(VENDOR_PUBLIC_KEY)?;
    let bytes: [u8; 32] = raw
        .try_into()
        .ok()
        .context("vendor public key is not 32 bytes")?;
    Ok(VerifyingKey::from_bytes(&bytes)?)
}

/// 验签并解出清单。任何一步不对都是拒绝，没有"部分接受"。
pub fn verify(signed: &str, key: &VerifyingKey) -> Result<KernelList> {
    let mut parts = signed.trim().split('.');
    let (Some("k1"), Some(body), Some(sig), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        bail!("格式不对");
    };
    let signature =
        Signature::from_slice(&URL_SAFE_NO_PAD.decode(sig).context("签名不是 base64url")?)
            .context("签名长度不对")?;
    key.verify_strict(format!("{SIGN_DOMAIN}{body}").as_bytes(), &signature)
        .ok()
        .context("签名不对")?;

    let list: KernelList =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).context("内容不是 base64url")?)
            .context("内容解不开")?;
    if list.v != 1 {
        bail!("不认识的清单版本 {}", list.v);
    }
    for k in &list.kernels {
        check_record(k).with_context(|| format!("内核 {} 的记录不合格", k.version))?;
    }
    Ok(list)
}

/// 签名对，不等于记录就能用：地址要在上游发布目录下，哈希和文件名要像样。
fn check_record(k: &KernelRecord) -> Result<()> {
    // 先规整再比：".." 能让一个以上游前缀开头的地址实际指到别的仓库。
    let normalized = reqwest::Url::parse(&k.url).context("下载地址不是合法的 URL")?;
    if normalized.as_str() != k.url || !k.url.starts_with(UPSTREAM_PREFIX) {
        bail!("下载地址不在上游发布目录下");
    }
    if k.sha256.len() != 64 || !k.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("哈希不是 64 位十六进制");
    }
    // 文件名会被拼进本机路径。
    let plain = !k.filename.is_empty()
        && k.filename
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
        && !k.filename.starts_with('.');
    if !plain {
        bail!("文件名不合格");
    }
    if !crate::kernel::valid_version(&k.version) || k.id != "fingerprint-chromium" {
        bail!("版本号或内核 id 不合格");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn record(url: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "fingerprint-chromium", "version": "150.0.1.2", "platform": "win-x64",
            "channel": "candidate", "url": url, "filename": "kernel_150.zip",
            "sha256": "a".repeat(64), "bytes": 189767686u64, "publisher": "adryfish",
            "releasedAt": "2026-09-20T00:00:00.000Z", "upstream": "Ungoogled Chromium",
            "license": "BSD-3-Clause", "notes": ""
        })
    }

    fn sign(key: &SigningKey, domain: &str, kernels: Vec<serde_json::Value>) -> String {
        let payload =
            serde_json::json!({ "v": 1, "issuedAt": 1_790_000_000_000u64, "kernels": kernels });
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let sig = key.sign(format!("{domain}{body}").as_bytes());
        format!("k1.{body}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    fn good_url() -> String {
        format!("{UPSTREAM_PREFIX}150.0.1.2/kernel_150.zip")
    }

    #[test]
    fn accepts_a_list_signed_by_the_vendor_key() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let signed = sign(&key, SIGN_DOMAIN, vec![record(&good_url())]);
        let list = verify(&signed, &key.verifying_key()).unwrap();
        assert_eq!(list.issued_at, 1_790_000_000_000);
        assert_eq!(list.kernels[0].version, "150.0.1.2");
    }

    #[test]
    fn rejects_other_keys_tampering_and_a_licence_style_signature() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let signed = sign(&key, SIGN_DOMAIN, vec![record(&good_url())]);

        assert!(
            verify(&signed, &other.verifying_key()).is_err(),
            "别人的钥匙"
        );

        let mut parts: Vec<String> = signed.split('.').map(String::from).collect();
        let mut body = URL_SAFE_NO_PAD.decode(&parts[1]).unwrap();
        let at = body.windows(3).position(|w| w == b"150").unwrap();
        body[at + 2] = b'1';
        parts[1] = URL_SAFE_NO_PAD.encode(body);
        assert!(
            verify(&parts.join("."), &key.verifying_key()).is_err(),
            "改过内容"
        );

        // 许可证签的是裸 body，没有域前缀。同一把钥匙签出来的那种签名在这里不能通过。
        let bare = sign(&key, "", vec![record(&good_url())]);
        assert!(verify(&bare, &key.verifying_key()).is_err(), "没有域前缀");

        assert!(verify("v1.abc.def", &key.verifying_key()).is_err());
        assert!(verify("", &key.verifying_key()).is_err());
    }

    #[test]
    fn a_valid_signature_does_not_excuse_a_bad_record() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let vk = key.verifying_key();
        for url in [
            "https://evil.example/kernel_150.zip".to_string(),
            format!("{UPSTREAM_PREFIX}../../../../evil/repo/releases/download/1/kernel_150.zip"),
            "http://github.com/adryfish/fingerprint-chromium/releases/download/1/k.zip".to_string(),
        ] {
            let signed = sign(&key, SIGN_DOMAIN, vec![record(&url)]);
            assert!(verify(&signed, &vk).is_err(), "{url} 不该被接受");
        }
        let mut traversal = record(&good_url());
        traversal["filename"] = "../../evil.zip".into();
        assert!(verify(&sign(&key, SIGN_DOMAIN, vec![traversal]), &vk).is_err());
        let mut version = record(&good_url());
        version["version"] = "../150".into();
        assert!(verify(&sign(&key, SIGN_DOMAIN, vec![version]), &vk).is_err());
    }

    #[test]
    fn built_in_key_is_the_one_the_workbench_verifies_licences_with() {
        vendor_key().expect("内置公钥要能解出来");
        let ts = include_str!("../../../src/lib/license/public-key.ts");
        assert!(
            ts.contains(&format!("\"{VENDOR_PUBLIC_KEY}\"")),
            "Host 和工作台的厂商公钥不一致，换钥匙时要两处一起换"
        );
    }
}
