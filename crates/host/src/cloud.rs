//! 云端会话：登录、额度、环境名额、运行租约。
//!
//! 订阅状态以服务器为准。本机不留"几天内有效"的凭据：新建环境、启动环境之前都来问一次，
//! 服务器连不上就新建不了、启动不了。已经在跑的浏览器不受断网影响。
//!
//! 和服务器说话的只有 Host。工作台页面不碰设备令牌，也不直接连服务器——
//! 令牌放在系统钥匙串里（Windows 凭据管理器、macOS 钥匙串），页面里的脚本读不到它。
//!
//! 登录不经手密码：Host 生成一对 verifier / challenge，打开官网让用户在那里登录并点"允许"，
//! 官网把一次性授权码经 `enclave://auth` 交回来，Host 用 授权码 + verifier 换设备令牌。
//! 别的程序就算截到了那个链接，没有 verifier 也换不出令牌。

use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::Mutex;

/// 打包时写进来的服务器地址。没有它，这个版本登录不了，也就什么都做不了。
const BUILT_IN_URL: Option<&str> = option_env!("ENCLAVE_CLOUD_URL");

/// 多久续一次租约。服务器那边 60 秒没续就释放，所以留了两次失败的余量。
pub const HEARTBEAT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct CloudError {
    pub code: String,
    pub message: String,
}

impl CloudError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn json(&self) -> Value {
        json!({ "ok": false, "code": self.code, "message": self.message })
    }

    /// 服务器明确说这台设备的登录已经作废（被解绑、退出过）。
    fn revoked(&self) -> bool {
        self.code == "DEVICE_REVOKED" || self.code == "UNAUTHENTICATED"
    }
}

struct Session {
    token: String,
    email: String,
}

pub struct Cloud {
    base: Option<String>,
    http: reqwest::Client,
    dir: PathBuf,
    device_id: String,
    session: Mutex<Option<Session>>,
    /// 正在进行的那次登录的 verifier。只在内存里，换到令牌就丢掉。
    pending: Mutex<Option<String>>,
    /// 服务器上一次回答的额度。只给本机 API 的权限判断用；新建和启动从不看它，每次都问服务器。
    plan: Mutex<Option<Value>>,
    /// 这台电脑现在持有租约的环境。
    leases: Mutex<HashSet<String>>,
    /// 租约丢了、已经被 Host 停掉的环境，等工作台来取走并告诉用户。
    lost: Mutex<Vec<Value>>,
}

/// 服务器地址只接受 https；回环地址例外，给本机联调用。
/// 设备令牌走明文 http 出这台机器，等于把登录态交给路上的任何人。
pub fn valid_base(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let loopback = ["http://127.0.0.1", "http://localhost"].iter().any(|p| {
        url.strip_prefix(p)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
    });
    let https = url
        .strip_prefix("https://")
        .is_some_and(|rest| !rest.is_empty() && !rest.contains(['/', '@', '?', '#']));
    (https || loopback).then(|| url.to_string())
}

fn configured_base() -> Option<String> {
    // 调试版可以用环境变量指到本机的服务器；发布版只认打包时写进来的那个，
    // 不然改一个环境变量就能把工作台指到一台"什么都允许"的假服务器上。
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("ENCLAVE_CLOUD_URL") {
        return valid_base(&url);
    }
    BUILT_IN_URL.and_then(valid_base)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    hex::encode(buf)
}

pub fn challenge_of(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// 环境 id 只有字母、数字、下划线和连字符，可以原样放进路径；别的形状根本不往服务器送。
fn profile_path(env_id: &str, action: &str) -> Result<String, CloudError> {
    if !crate::kernel::valid_env_id(env_id) {
        return Err(CloudError::new("BAD_ENV_ID", "环境 id 不合法。"));
    }
    Ok(format!("/v1/profiles/{env_id}{action}"))
}

fn device_name() -> String {
    let host = gethostname::gethostname()
        .to_string_lossy()
        .trim()
        .to_string();
    let os = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        other => other,
    };
    if host.is_empty() {
        format!("{os} 电脑")
    } else {
        format!("{host}（{os}）")
    }
}

/// 官网交回来的授权码。只认这一种形状，别的一概不往服务器送。
pub fn valid_code(code: &str) -> bool {
    (20..=128).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Cloud {
    pub fn load(dir: &Path) -> Self {
        Self::with_base(dir, configured_base())
    }

    pub fn with_base(dir: &Path, base: Option<String>) -> Self {
        let id_file = dir.join("device.id");
        let device_id = std::fs::read_to_string(&id_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .unwrap_or_else(|| {
                let id = random_hex(16);
                let _ = std::fs::write(&id_file, &id);
                id
            });
        let session = token_store::load(dir).map(|token| Session {
            token,
            email: std::fs::read_to_string(dir.join("account.email"))
                .map(|s| s.trim().to_string())
                .unwrap_or_default(),
        });
        Self {
            base,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .user_agent(concat!("enclave-host/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
            dir: dir.to_path_buf(),
            device_id,
            session: Mutex::new(session),
            pending: Mutex::new(None),
            plan: Mutex::new(None),
            leases: Mutex::new(HashSet::new()),
            lost: Mutex::new(Vec::new()),
        }
    }

    fn base(&self) -> Result<&str, CloudError> {
        self.base.as_deref().ok_or_else(|| {
            CloudError::new(
                "CLOUD_NOT_CONFIGURED",
                "这个版本没有写入服务器地址，登录不了。请从官网下载正式安装包。",
            )
        })
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        signed: bool,
    ) -> Result<Value, CloudError> {
        let base = self.base()?;
        let mut req = self.http.request(method, format!("{base}/api{path}"));
        if signed {
            let session = self.session.lock().await;
            let Some(s) = session.as_ref() else {
                return Err(CloudError::new("NOT_SIGNED_IN", "还没有登录。"));
            };
            req = req.bearer_auth(&s.token);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.map_err(|_| {
            CloudError::new(
                "CLOUD_UNREACHABLE",
                "连不上服务器。新建和启动环境需要联网；已经在运行的环境不受影响。",
            )
        })?;
        let status = res.status();
        let Ok(data) = res.json::<Value>().await else {
            return Err(CloudError::new(
                "CLOUD_UNREACHABLE",
                &format!("服务器的回答看不懂（HTTP {}），稍后再试。", status.as_u16()),
            ));
        };
        if status.is_success() && data["ok"] != false {
            return Ok(data);
        }
        let err = CloudError {
            code: data["code"].as_str().unwrap_or("CLOUD_ERROR").to_string(),
            message: data["message"]
                .as_str()
                .unwrap_or("服务器拒绝了这次请求。")
                .to_string(),
        };
        if signed && err.revoked() {
            // 静默登出最难查：留一行，写清楚是服务器说的哪一句。
            eprintln!("这台设备的登录被服务器判为失效（{}：{}）", err.code, err.message);
            self.forget().await;
            return Err(CloudError::new(
                "DEVICE_REVOKED",
                "这台电脑的登录已经失效（可能在官网被解绑了），请重新登录。",
            ));
        }
        Err(err)
    }

    async fn forget(&self) {
        *self.session.lock().await = None;
        *self.plan.lock().await = None;
        token_store::clear(&self.dir);
        let _ = std::fs::remove_file(self.dir.join("account.email"));
    }

    /// 官网上的一页。
    pub fn site_url(&self, page: &str) -> Result<String, CloudError> {
        Ok(format!("{}/{page}", self.base()?))
    }

    /* ── 登录 ───────────────────────────────────────────── */

    /// 开始一次登录，返回要在系统浏览器里打开的官网地址。
    pub async fn begin_login(&self) -> Result<String, CloudError> {
        let base = self.base()?;
        let verifier = random_hex(32);
        let url = format!(
            "{base}/device?challenge={}&device={}&name={}",
            challenge_of(&verifier),
            enc(&self.device_id),
            enc(&device_name()),
        );
        *self.pending.lock().await = Some(verifier);
        Ok(url)
    }

    /// 用官网交回来的授权码换设备令牌。
    pub async fn complete_login(&self, code: &str) -> Result<(), CloudError> {
        if !valid_code(code) {
            return Err(CloudError::new(
                "BAD_CODE",
                "这不是一个授权码。回到官网那一页，把授权码整段复制过来。",
            ));
        }
        let Some(verifier) = self.pending.lock().await.clone() else {
            return Err(CloudError::new(
                "NO_PENDING_LOGIN",
                "这次登录不是从这个工作台发起的。点一次「登录」，再到官网允许。",
            ));
        };
        let data = self
            .call(
                reqwest::Method::POST,
                "/v1/device/exchange",
                Some(json!({ "code": code, "verifier": verifier })),
                false,
            )
            .await?;
        let token = data["token"].as_str().unwrap_or_default().to_string();
        let email = data["email"].as_str().unwrap_or_default().to_string();
        if token.is_empty() {
            return Err(CloudError::new("CLOUD_ERROR", "服务器没有发回设备令牌。"));
        }
        token_store::save(&self.dir, &token).map_err(|e| {
            CloudError::new(
                "KEYCHAIN_FAILED",
                &format!("登录成功了，但设备令牌没能存进系统钥匙串：{e}"),
            )
        })?;
        let _ = std::fs::write(self.dir.join("account.email"), &email);
        *self.pending.lock().await = None;
        *self.session.lock().await = Some(Session { token, email });
        Ok(())
    }

    /// 退出登录。服务器那边同时解绑这台设备、收回它占的运行名额；连不上也要让本机立刻退出。
    pub async fn logout(&self) {
        let _ = self
            .call(reqwest::Method::POST, "/v1/device/logout", None, true)
            .await;
        self.leases.lock().await.clear();
        self.forget().await;
    }

    /* ── 额度 ───────────────────────────────────────────── */

    /// 给工作台看的会话状态。登录了就现问服务器，不用缓存里的。
    pub async fn view(&self) -> Value {
        let mut out = json!({
            "ok": true,
            "configured": self.base.is_some(),
            "siteUrl": self.base,
            "deviceId": self.device_id,
            "signedIn": false,
            "online": true,
            "lost": std::mem::take(&mut *self.lost.lock().await),
        });
        let Some(email) = self.session.lock().await.as_ref().map(|s| s.email.clone()) else {
            return out;
        };
        out["signedIn"] = json!(true);
        out["email"] = json!(email);
        match self.entitlement().await {
            Ok(data) => {
                for key in ["email", "role", "plan", "expiresAt", "profiles", "running"] {
                    out[key] = data[key].clone();
                }
            }
            Err(e) if e.code == "DEVICE_REVOKED" => {
                out["signedIn"] = json!(false);
                out["error"] = e.json();
            }
            Err(e) => {
                out["online"] = json!(false);
                out["error"] = e.json();
            }
        }
        out
    }

    async fn entitlement(&self) -> Result<Value, CloudError> {
        let data = self
            .call(reqwest::Method::GET, "/v1/entitlement", None, true)
            .await?;
        *self.plan.lock().await = Some(data["plan"].clone());
        Ok(data)
    }

    /// 本机 API 的权限档（off / discover / full）。服务器没回答过就是 off。
    /// 工作台开着时每分钟会问一次会话状态，这里看到的档位最多旧一分钟。
    pub async fn api_level(&self) -> String {
        if self.plan.lock().await.is_none() {
            let _ = self.entitlement().await;
        }
        self.plan
            .lock()
            .await
            .as_ref()
            .and_then(|p| p["api"].as_str())
            .unwrap_or("off")
            .to_string()
    }

    /* ── 环境名额 ───────────────────────────────────────── */

    /// 登记或更新一个环境。新登记要占一个名额，名额由服务器数。
    pub async fn put_profile(&self, id: &str, body: Value) -> Result<Value, CloudError> {
        self.call(
            reqwest::Method::PUT,
            &profile_path(id, "")?,
            Some(body),
            true,
        )
        .await
    }

    pub async fn delete_profile(&self, id: &str) -> Result<Value, CloudError> {
        self.call(reqwest::Method::DELETE, &profile_path(id, "")?, None, true)
            .await
    }

    /* ── 运行租约 ───────────────────────────────────────── */

    /// 启动前申请。服务器在这里数同时运行数，并保证同一个环境同一时刻只在一台电脑上开着。
    pub async fn acquire(&self, env_id: &str) -> Result<(), CloudError> {
        self.call(
            reqwest::Method::POST,
            &profile_path(env_id, "/start")?,
            None,
            true,
        )
        .await?;
        self.leases.lock().await.insert(env_id.to_string());
        Ok(())
    }

    /// 环境停了，把名额还回去。连不上也没关系：60 秒没续，服务器自己会收回。
    pub async fn release(&self, env_id: &str) {
        let Ok(path) = profile_path(env_id, "/stop") else {
            return;
        };
        if self.leases.lock().await.remove(env_id) {
            let _ = self.call(reqwest::Method::POST, &path, None, true).await;
        }
    }

    /// Host 重启后，上次留下来还在跑的环境继续续约。
    pub async fn adopt(&self, env_ids: impl IntoIterator<Item = String>) {
        self.leases.lock().await.extend(env_ids);
    }

    /// 每 20 秒一次。`alive` 是此刻真的还在跑的环境。
    /// 返回租约已经丢了的环境：调用方要把它们停掉——同一个环境不能两台电脑同时开着。
    /// 只是连不上服务器的话什么都不停，下一轮再试。
    pub async fn tick(&self, alive: &HashSet<String>) -> Vec<String> {
        let held: Vec<String> = self.leases.lock().await.iter().cloned().collect();
        let mut lost = Vec::new();
        for env_id in held {
            if !alive.contains(&env_id) {
                // 用户自己关掉了浏览器窗口。
                self.release(&env_id).await;
                continue;
            }
            let Ok(path) = profile_path(&env_id, "/heartbeat") else {
                continue;
            };
            let res = self.call(reqwest::Method::POST, &path, None, true).await;
            let reason = match res {
                Ok(data) if data["held"] == true => continue,
                Ok(_) => CloudError::new(
                    "LEASE_LOST",
                    "这个环境已经在另一台电脑上打开，或者账号的同时运行名额被占满了，本机已停止它。",
                ),
                Err(e) if e.code == "DEVICE_REVOKED" || e.code == "NOT_SIGNED_IN" => CloudError::new(
                    "DEVICE_REVOKED",
                    "这台电脑的登录已经失效（可能在官网被解绑了），本机已停止这个环境。",
                ),
                Err(_) => continue,
            };
            self.leases.lock().await.remove(&env_id);
            self.lost.lock().await.push(json!({
                "envId": env_id, "code": reason.code, "message": reason.message,
            }));
            lost.push(env_id);
        }
        lost
    }

    /* ── 同步密钥的交接 ─────────────────────────────────── */

    pub async fn sync_get(&self, path: &str) -> Result<Value, CloudError> {
        self.call(reqwest::Method::GET, path, None, true).await
    }

    pub async fn sync_put(&self, path: &str, body: Value) -> Result<Value, CloudError> {
        self.call(reqwest::Method::PUT, path, Some(body), true).await
    }

    pub async fn sync_post(&self, path: &str, body: Value) -> Result<Value, CloudError> {
        self.call(reqwest::Method::POST, path, Some(body), true)
            .await
    }

    /// 把一段密文直接传到对象存储（地址是服务器签的，有时限）。密文不经过我们的服务器。
    pub async fn put_blob(&self, url: &str, body: Vec<u8>) -> Result<(), CloudError> {
        let res =
            self.http.put(url).body(body).send().await.map_err(|_| {
                CloudError::new("BLOB_UPLOAD_FAILED", "登录态没传上去，稍后会再试。")
            })?;
        if !res.status().is_success() {
            return Err(CloudError::new(
                "BLOB_UPLOAD_FAILED",
                &format!("对象存储回了 {}。", res.status().as_u16()),
            ));
        }
        Ok(())
    }

    pub async fn get_blob(&self, url: &str) -> Result<Vec<u8>, CloudError> {
        let res = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| CloudError::new("BLOB_DOWNLOAD_FAILED", "登录态没取下来。"))?;
        if !res.status().is_success() {
            return Err(CloudError::new(
                "BLOB_DOWNLOAD_FAILED",
                &format!("对象存储回了 {}。", res.status().as_u16()),
            ));
        }
        res.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|_| CloudError::new("BLOB_DOWNLOAD_FAILED", "登录态读不完整。"))
    }

    pub async fn sync_delete(&self, path: &str) -> Result<Value, CloudError> {
        self.call(reqwest::Method::DELETE, path, None, true).await
    }

    /* ── 内核清单 ───────────────────────────────────────── */

    /// 管理员上架的内核清单，签过名的一段文字。验签在 feed.rs，这里只负责取。
    pub async fn kernel_feed(&self) -> Result<String, CloudError> {
        let data = self
            .call(reqwest::Method::GET, "/v1/kernels", None, false)
            .await?;
        Ok(data["signed"].as_str().unwrap_or_default().to_string())
    }
}

/// 设备令牌放在本机保密存储里（见 keychain.rs）。
pub mod token_store {
    use crate::keychain;
    use std::path::Path;

    const ITEM: &str = "device-token";

    pub fn save(dir: &Path, token: &str) -> Result<(), String> {
        keychain::save(dir, ITEM, token)
    }

    pub fn load(dir: &Path) -> Option<String> {
        keychain::load(dir, ITEM)
    }

    pub fn clear(dir: &Path) {
        keychain::clear(dir, ITEM)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_address_must_be_https_unless_loopback() {
        assert_eq!(
            valid_base("https://enclave.example/").as_deref(),
            Some("https://enclave.example")
        );
        assert_eq!(
            valid_base("http://127.0.0.1:3011").as_deref(),
            Some("http://127.0.0.1:3011")
        );
        assert_eq!(
            valid_base("http://localhost").as_deref(),
            Some("http://localhost")
        );
        for bad in [
            "http://enclave.example",
            "http://127.0.0.1.evil.example",
            "http://localhost.evil.example:80",
            "https://user@evil.example",
            "https://enclave.example/path",
            "https://",
            "ftp://127.0.0.1",
            "",
        ] {
            assert!(valid_base(bad).is_none(), "{bad} 不该被接受");
        }
    }

    #[test]
    fn challenge_is_the_url_safe_sha256_of_the_verifier() {
        // 和服务器（Go）、官网那一页用的是同一个算法：这个值三边必须一致。
        assert_eq!(
            challenge_of("x"),
            "LXEWQrcmsEQBYnyp-6wy9chTD7GQPMTbAiWHF5IaSIE"
        );
        assert_eq!(challenge_of(&random_hex(32)).len(), 43);
    }

    #[test]
    fn only_code_shaped_strings_reach_the_server() {
        assert!(valid_code("Zk3vYw0m1dXq8n2Lr5t7Aa9Bc4De6Fg_h-JKLMNOPQR"));
        for bad in [
            "",
            "short",
            "has space in it 1234567890",
            "../../v1/entitlement?x=12345",
            &"a".repeat(129),
        ] {
            assert!(!valid_code(bad), "{bad}");
        }
    }

    #[test]
    fn device_token_round_trips_through_the_store() {
        // 在 Windows / macOS 的 CI 上，这一条测的就是真的系统钥匙串。
        let dir = std::env::temp_dir().join(format!("enclave-token-{}", random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        token_store::clear(&dir);
        assert_eq!(token_store::load(&dir), None);
        token_store::save(&dir, "tok-1").unwrap();
        token_store::save(&dir, "tok-2").unwrap();
        assert_eq!(token_store::load(&dir).as_deref(), Some("tok-2"));
        token_store::clear(&dir);
        assert_eq!(token_store::load(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn without_a_server_address_nothing_is_allowed() {
        let dir = std::env::temp_dir().join(format!("enclave-cloud-{}", random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let cloud = Cloud::with_base(&dir, None);
        assert_eq!(
            cloud.begin_login().await.unwrap_err().code,
            "CLOUD_NOT_CONFIGURED"
        );
        assert_eq!(
            cloud.acquire("env_a").await.unwrap_err().code,
            "CLOUD_NOT_CONFIGURED"
        );
        assert_eq!(cloud.view().await["configured"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn starting_needs_a_login_and_a_reachable_server() {
        let dir = std::env::temp_dir().join(format!("enclave-cloud-{}", random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        // 9 号端口（discard）上没有服务：连不上。
        let cloud = Cloud::with_base(&dir, valid_base("http://127.0.0.1:9"));
        assert_eq!(
            cloud.acquire("env_a").await.unwrap_err().code,
            "NOT_SIGNED_IN"
        );
        assert_eq!(
            cloud
                .complete_login(&"c".repeat(43))
                .await
                .unwrap_err()
                .code,
            "NO_PENDING_LOGIN"
        );
        let url = cloud.begin_login().await.unwrap();
        assert!(
            url.starts_with("http://127.0.0.1:9/device?challenge="),
            "{url}"
        );
        assert_eq!(
            cloud
                .complete_login(&"c".repeat(43))
                .await
                .unwrap_err()
                .code,
            "CLOUD_UNREACHABLE"
        );
        assert!(cloud.leases.lock().await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
