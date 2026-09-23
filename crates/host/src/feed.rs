//! 厂商远程上架的内核清单。
//!
//! 清单决定 Host 去哪里下载、下载回来执行什么，所以**只认签名**：
//!   k1.<base64url(payload)>.<base64url(ed25519 签名)>
//! 签的是 "enclave-kernels-v1." + body。验签用的公钥编译在这里，和工作台验许可证的是同一把；
//! 工作台只是把这段文字原样递过来，它说什么都不算数。
//!
//! 验过签还要再过两道：下载地址必须在上游发布目录之下，新清单不能比已经接受过的旧。

#[cfg(test)]
use crate::kernel::Engine;
use crate::kernel::KernelRecord;
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

/// 厂商公钥（32 字节 raw，base64url）。必须和服务器 /api/v1/pubkey 回答的一致，
/// 换钥匙时这里和服务器的密钥文件一起换，并发新版客户端。
pub const VENDOR_PUBLIC_KEY: &str = "dJpAOBHjnTuXrsDbZWiHngIBMlvsFEIWl1wRP3-visM";

const SIGN_DOMAIN: &str = "enclave-kernels-v1.";

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
    // 每一类内核只认自己上游项目的发布目录：签的是 Firefox 类，就不能指到 Chromium 那边去，反过来也一样。
    if normalized.as_str() != k.url || !k.url.starts_with(k.engine.upstream_prefix()) {
        bail!("下载地址不在这一类内核的上游发布目录下");
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
    if !crate::kernel::valid_version(&k.version) || k.id != k.engine.build_id() {
        bail!("版本号不合格，或者内核 id 和它的类对不上");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn record(url: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "fingerprint-chromium", "engine": "chromium", "version": "150.0.1.2", "platform": "win-x64",
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
        format!(
            "{}150.0.1.2/kernel_150.zip",
            Engine::Chromium.upstream_prefix()
        )
    }

    fn firefox_record() -> serde_json::Value {
        let mut r = record(&format!(
            "{}v152.0.4-beta.30/camoufox-152.0.4-beta.30-win.x86_64.zip",
            Engine::Firefox.upstream_prefix()
        ));
        r["id"] = "camoufox".into();
        r["engine"] = "firefox".into();
        r["version"] = "152.0.4-beta.30".into();
        r["filename"] = "camoufox-152.0.4-beta.30-win.x86_64.zip".into();
        r
    }

    #[test]
    fn each_engine_class_only_downloads_from_its_own_upstream() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let vk = key.verifying_key();
        let list = verify(&sign(&key, SIGN_DOMAIN, vec![firefox_record()]), &vk).unwrap();
        assert_eq!(list.kernels[0].engine, Engine::Firefox);
        assert_eq!(list.kernels[0].version, "152.0.4-beta.30");

        // Firefox 类的记录指到 Chromium 的上游去（或者反过来）：签名再对也不收。
        let mut crossed = firefox_record();
        crossed["url"] = good_url().into();
        assert!(verify(&sign(&key, SIGN_DOMAIN, vec![crossed]), &vk).is_err());
        let mut crossed = record(firefox_record()["url"].as_str().unwrap());
        crossed["filename"] = "k.zip".into();
        assert!(verify(&sign(&key, SIGN_DOMAIN, vec![crossed]), &vk).is_err());

        // 类和构建 id 对不上、不认识的类，都不收。
        let mut wrong_id = firefox_record();
        wrong_id["id"] = "fingerprint-chromium".into();
        assert!(verify(&sign(&key, SIGN_DOMAIN, vec![wrong_id]), &vk).is_err());
        let mut unknown = firefox_record();
        unknown["engine"] = "webkit".into();
        assert!(verify(&sign(&key, SIGN_DOMAIN, vec![unknown]), &vk).is_err());
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
            format!(
                "{}../../../../evil/repo/releases/download/1/kernel_150.zip",
                Engine::Chromium.upstream_prefix()
            ),
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
    fn built_in_key_decodes() {
        // 这把公钥现在只在这一处：服务器的 /api/v1/pubkey 要和它一致（见 enclave-www 的 docs/deploy.md）。
        vendor_key().expect("内置公钥要能解出来");
    }
}
