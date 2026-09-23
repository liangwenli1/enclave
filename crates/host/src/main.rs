//! Enclave 本机 Host。
//!
//! 只监听 127.0.0.1。三道门，缺一不可：
//!   1. Host 头必须是回环地址 —— 挡 DNS rebinding。
//!   2. Origin 如果有，必须是工作台自己的 WebView 来源 —— 挡任意网页跨域调用。
//!   3. Bearer 令牌必须匹配 —— 挡同机的其他程序。
//!
//! 令牌是 32 字节 OsRng 随机数，存在数据目录下，权限只给当前用户。
//! **没有任何"跳过鉴权"的开关**：桌面壳通过环境变量把令牌交给 Host，
//! 再注入给 WebView，两边拿的是同一个值。
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use enclave_host::api::{allows, ApiLevel, EnvEntry, StartSpec};
use enclave_host::cloud::{Cloud, HEARTBEAT};
use enclave_host::feed;
use enclave_host::kernel::{
    admit, capabilities, default_version, ensure_dirs, kernels_for_this_os, list_search_engines,
    load_manifest, prune_dead, purge_environment, read_status_fast, remove_kernel,
    restore_runtimes, saved_records, start_environment, stop_environment, this_platform,
    valid_env_id, version_key, Bridges, Engine, HostPaths, KernelRecord, KernelStatus, Launch,
    RuntimeRow,
};
use enclave_host::slots::Keyring;
use enclave_host::store::{self, Kind, Store};
use enclave_host::sync::DeviceKey;
use enclave_host::vault::{self, Vault};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// 工作台 WebView 的来源。Tauri 在各平台用的 scheme 不同，开发时是 Vite。
/// 这个名单之外的 Origin 一律拒绝，网页因此无法驱动 Host。
const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
];

struct App {
    paths: HostPaths,
    /// 这个系统能用的全部内核版本，新的在前。
    kernels: Mutex<Vec<Arc<KernelSlot>>>,
    /// 安装包自带清单里的版本。永远可信，远程清单盖不掉它们。
    bundled: Vec<KernelRecord>,
    /// 已接受的远程清单的签发时间。比它旧的清单不收，防止有人拿旧清单回放。
    feed_issued_at: Mutex<u64>,
    token: String,
    runtimes: Arc<Mutex<HashMap<String, RuntimeRow>>>,
    bridges: Bridges,
    api: Arc<Mutex<ApiState>>,
    /// 账号、额度、运行租约。订阅状态以服务器为准，见 cloud.rs。
    cloud: Cloud,
    /// 最近几次批量执行。只在内存里：账本是服务器上的操作日志，不是这里。
    batch: enclave_host::batch::Runs,
    /// 同一个代理出口别扎堆：同时最多两个、两次之间隔够 30 秒。
    gate: enclave_host::batch::Gate,
    /// 每个环境一条盯着新标签页的连接（只有 Chromium 类要）。环境停掉时取消它。
    supervisors: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    /// 环境、代理、代理密码的真相。页面只是它的界面。
    store: Store,
    /// 数据密钥（平时在系统钥匙串里）和可选的应用锁。
    vault: Mutex<Vault>,
}

/// 一个内核版本和它在本进程里的状态。版本之间互不影响：可以一个在下载、另一个在跑。
struct KernelSlot {
    record: KernelRecord,
    /// 清单里已经没有它了，只是本机还留着下载好的文件：能用、能删，不能再下载。
    withdrawn: bool,
    status: Arc<Mutex<KernelStatus>>,
    admitting: Arc<Mutex<bool>>,
    /// 本进程是否已经完整校验过这个版本的可执行文件。第一次启动环境时做全量 sha256，
    /// 之后只比对大小与修改时间，免得每次启动都读一遍上百 MB。
    verified_once: AtomicBool,
}

impl KernelSlot {
    async fn load(paths: &HostPaths, record: KernelRecord, withdrawn: bool) -> Arc<Self> {
        let status = read_status_fast(paths, &record).await;
        Arc::new(Self {
            record,
            withdrawn,
            status: Arc::new(Mutex::new(status)),
            admitting: Arc::new(Mutex::new(false)),
            verified_once: AtomicBool::new(false),
        })
    }

    /// 准入进行中、或者刚失败，真相在内存里：下载写的是 .part，磁盘上看不出进度，
    /// 失败原因也不落盘。这时从磁盘重算会把它们盖成"未下载"，界面既没进度也没报错。
    async fn current_status(&self, paths: &HostPaths) -> KernelStatus {
        {
            let s = self.status.lock().await;
            if *self.admitting.lock().await || s.state == "error" {
                return s.clone();
            }
        }
        let fresh = read_status_fast(paths, &self.record).await;
        *self.status.lock().await = fresh.clone();
        fresh
    }
}

impl App {
    /// 这个人在团队里的角色。登录时服务器说过一次，记在本机；断网时按记下的那个算。
    /// 一个人用的账号永远是 owner，所以单机用户不受影响。
    fn role(&self) -> String {
        self.store
            .meta("role")
            .unwrap_or_else(|| "owner".to_string())
    }

    /// 重新拼出版本列表：自带的 + 远程上架的（同版本以自带的为准）+ 本机还留着的已下架版本。
    /// 记录没变的版本沿用原来的槽位，正在下载的、校验过的状态都不丢。
    async fn rebuild_kernels(&self, remote: &[KernelRecord]) {
        let mut wanted: Vec<(KernelRecord, bool)> = Vec::new();
        let listed = self.bundled.iter().chain(remote.iter());
        for record in listed.filter(|k| k.platform == this_platform()) {
            if !wanted.iter().any(|(k, _)| k.version == record.version) {
                wanted.push((record.clone(), false));
            }
        }
        for record in saved_records(&self.paths) {
            if !wanted.iter().any(|(k, _)| k.version == record.version) {
                wanted.push((record, true));
            }
        }
        wanted.sort_by_key(|(k, _)| std::cmp::Reverse(version_key(&k.version)));

        let mut slots = self.kernels.lock().await;
        let mut next = Vec::new();
        for (record, withdrawn) in wanted {
            let kept = slots
                .iter()
                .find(|s| s.record == record && s.withdrawn == withdrawn)
                .cloned();
            next.push(match kept {
                Some(slot) => slot,
                None => KernelSlot::load(&self.paths, record, withdrawn).await,
            });
        }
        // 正在下载的版本即使被下架了也让它做完，下一次重拼时再按规矩处理。
        for slot in slots.iter() {
            let gone = !next.iter().any(|n| n.record.version == slot.record.version);
            if gone && *slot.admitting.lock().await {
                next.push(slot.clone());
            }
        }
        *slots = next;
    }

    /// 收下一份远程清单：验签、不许回退、落盘、重拼。
    async fn accept_feed(&self, signed: &str) -> anyhow::Result<usize> {
        let list = feed::verify(signed, &feed::vendor_key()?)?;
        {
            let mut latest = self.feed_issued_at.lock().await;
            if list.issued_at < *latest {
                anyhow::bail!("这份清单比已经接受过的旧");
            }
            *latest = list.issued_at;
        }
        tokio::fs::write(feed_path(&self.paths), signed).await?;
        self.rebuild_kernels(&list.kernels).await;
        Ok(list.kernels.len())
    }

    async fn slot(&self, version: &str) -> Option<Arc<KernelSlot>> {
        self.kernels
            .lock()
            .await
            .iter()
            .find(|k| k.record.version == version)
            .cloned()
    }
}

/// 上一次接受的远程清单。重启、离线时靠它，版本列表不会缩回去。
fn feed_path(paths: &HostPaths) -> PathBuf {
    paths.kernel_root.join("feed.signed")
}

fn unknown_kernel(version: &str) -> Json<Value> {
    Json(json!({
        "ok": false,
        "code": "KERNEL_UNTRUSTED_SOURCE",
        "message": format!("清单里没有内核 {version}。"),
    }))
}

/// 给脚本用的 API 的运行时状态。开关和环境清单由工作台推过来，只在内存里；
/// 能做什么看档位，档位是 Host 自己问服务器得来的，不听工作台的。
/// 只有令牌落盘（0600），这样重启后脚本那边配置的令牌还能用。
#[derive(Default)]
struct ApiState {
    enabled: bool,
    token: String,
    envs: HashMap<String, EnvEntry>,
}

#[tokio::main]
async fn main() {
    let cwd = std::env::current_dir().expect("cwd");
    let paths = HostPaths::new(&cwd);
    ensure_dirs(&paths).await.expect("data dirs");
    let token = load_or_create_token(&paths.token);
    let manifest = load_manifest(&paths.manifest).expect("kernels.manifest.json");
    let bundled = kernels_for_this_os(&manifest);
    assert!(!bundled.is_empty(), "本平台没有可用内核清单");
    let runtimes = Arc::new(Mutex::new(HashMap::new()));
    restore_runtimes(&paths, &runtimes).await;
    let api = ApiState {
        token: std::fs::read_to_string(api_token_path(&paths))
            .map(|t| t.trim().to_string())
            .unwrap_or_default(),
        ..ApiState::default()
    };
    let cloud = Cloud::load(&paths.root);
    // 上次留下来还在跑的环境：租约接着续。
    cloud.adopt(runtimes.lock().await.keys().cloned()).await;
    let store = Store::open(&paths.root).expect("store.db");
    let vault = Vault::load(&paths.root).expect("data key");
    let state = Arc::new(App {
        store,
        vault: Mutex::new(vault),
        cloud,
        paths,
        kernels: Mutex::new(Vec::new()),
        bundled,
        feed_issued_at: Mutex::new(0),
        token,
        runtimes,
        bridges: Arc::new(Mutex::new(HashMap::new())),
        api: Arc::new(Mutex::new(api)),
        batch: Default::default(),
        gate: Default::default(),
        supervisors: Mutex::new(HashMap::new()),
    });

    // 落盘的那份清单重新验一遍再用：磁盘上的东西不因为是自己写的就可信。
    let saved_feed = tokio::fs::read_to_string(feed_path(&state.paths)).await;
    match saved_feed {
        Ok(signed) if state.accept_feed(&signed).await.is_ok() => {}
        _ => state.rebuild_kernels(&[]).await,
    }

    tokio::spawn(keep_leases(state.clone()));

    let origins: Vec<HeaderValue> = APP_ORIGINS
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();

    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/kernel", get(kernel_view))
        .route("/v1/kernel/admit", post(kernel_admit))
        .route("/v1/kernel/remove", post(kernel_remove))
        .route("/v1/kernel/feed", post(kernel_feed))
        .route("/v1/session", get(session_view))
        .route("/v1/session/login", post(session_login))
        .route("/v1/session/complete", post(session_complete))
        .route("/v1/session/logout", post(session_logout))
        .route("/v1/session/site", post(session_site))
        .route("/v1/profiles/:id", put(profile_put).delete(profile_delete))
        .route("/v1/folders", get(folders_list))
        .route("/v1/folders/:id", put(folder_put).delete(folder_delete))
        .route("/v1/store", get(store_all))
        .route(
            "/v1/store/environments/:id",
            put(env_put).delete(env_delete),
        )
        .route("/v1/store/proxies/:id", put(proxy_put).delete(proxy_delete))
        .route(
            "/v1/store/workflows/:id",
            put(workflow_put).delete(workflow_delete),
        )
        .route("/v1/secrets/:id", put(secret_put).delete(secret_delete))
        .route("/v1/secrets/export", post(secrets_export))
        .route("/v1/secrets/import", post(secrets_import))
        .route("/v1/vault", get(vault_view))
        .route("/v1/vault/unlock", post(vault_unlock))
        .route("/v1/vault/lock", post(vault_lock))
        .route("/v1/vault/app-lock", post(vault_app_lock))
        .route("/v1/vault/reset", post(vault_reset))
        .route("/v1/sync", get(sync_view))
        .route("/v1/sync/enable", post(sync_enable))
        .route("/v1/sync/pending", get(sync_pending))
        .route("/v1/sync/approve", post(sync_approve))
        .route("/v1/sync/adopt", post(sync_adopt))
        .route("/v1/sync/recover", post(sync_recover))
        .route("/v1/sync/disable", post(sync_disable))
        .route("/v1/sync/run", post(sync_run))
        .route("/v1/sync/usage", get(sync_usage))
        .route("/v1/flags/classify", post(flags_classify))
        .route("/v1/batch/run", post(batch_run))
        .route("/v1/batch/runs", get(batch_runs))
        .route("/v1/batch/cancel", post(batch_cancel))
        .route("/v1/environments/start", post(env_start))
        .route("/v1/environments/stop", post(env_stop))
        .route("/v1/environments/purge", post(env_purge))
        .route("/v1/search-engines", get(search_engines))
        .route("/v1/lab/collect", post(lab_collect))
        .route("/v1/api/config", post(api_config))
        .route("/v1/api/rotate", post(api_rotate))
        .route("/api/v1/environments", get(api_list))
        .route("/api/v1/environments/:id", get(api_get))
        .route("/api/v1/environments/:id/start", post(api_start))
        .route("/api/v1/environments/:id/stop", post(api_stop))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT])
                .max_age(std::time::Duration::from_secs(600)),
        )
        .with_state(state);

    // 端口可配，地址不可配：永远只绑回环。
    let port = std::env::var("ENCLAVE_HOST_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(17891);
    let bind = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    eprintln!("enclave-host listening on {bind}");
    axum::serve(listener, app).await.expect("serve");
}

/// 令牌来源优先级：桌面壳传进来的环境变量 > 磁盘上已有的 > 新生成。
/// 桌面壳和 WebView 必须拿到同一个值，所以壳启动 sidecar 时会显式传入。
fn load_or_create_token(path: &PathBuf) -> String {
    if let Ok(from_shell) = std::env::var("ENCLAVE_HOST_TOKEN") {
        let t = from_shell.trim().to_string();
        if t.len() >= 32 {
            let _ = std::fs::create_dir_all(path.parent().unwrap());
            write_private(path, &t);
            return t;
        }
    }
    if let Ok(existing) = std::fs::read_to_string(path) {
        let t = existing.trim();
        if t.len() >= 32 {
            return t.to_string();
        }
    }
    let token = new_token();
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    write_private(path, &token);
    token
}

/// 32 字节操作系统级随机数。以前这里是 DefaultHasher(时间+pid)，可以被穷举。
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn write_private(path: &PathBuf, token: &str) {
    let _ = std::fs::write(path, token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

/// 定长比较，不因为前缀相同就提前返回。
fn token_matches(given: &str, expected: &str) -> bool {
    let a = given.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn deny(code: &str, message: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "ok": false, "code": code, "message": message })),
    )
        .into_response()
}

/// 团队里的操作员碰不得的东西：团队的配置（环境、代理、代理密码、环境名额）、
/// 同步这把钥匙本身，以及所有能把东西带出去的出口。
/// 他能做的是打开分配给他的环境、跑同步、解锁应用锁——那些不在这张表里。
///
/// 判定放在这里一处，不散在各个处理函数里；服务器那边还会再判一次，两边都拒才算数。
fn operator_blocked(method: &Method, path: &str) -> bool {
    let write = method == Method::PUT || method == Method::DELETE;
    match path {
        "/v1/secrets/export" | "/v1/secrets/import" => true,
        "/v1/sync/enable" | "/v1/sync/disable" | "/v1/sync/approve" => true,
        _ => {
            write
                && (path.starts_with("/v1/store/")
                    || path.starts_with("/v1/secrets/")
                    || path.starts_with("/v1/profiles/"))
        }
    }
}

async fn guard(State(state): State<Arc<App>>, req: Request, next: Next) -> Response {
    // 1. Host 头必须是回环。浏览器把某个域名解析到 127.0.0.1 时，Host 头会是那个域名。
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| {
            let name = h.split(':').next().unwrap_or("");
            name == "127.0.0.1" || name == "localhost"
        })
        .unwrap_or(false);
    if !host_ok {
        return deny("BAD_HOST", "本机接口只接受回环地址访问。");
    }

    // 给脚本用的 API：独立令牌 + 档位权限。脚本从不带 Origin，网页必然带，
    // 所以这里只要看到 Origin 就拒绝 —— 连工作台自己的来源也不例外，它不需要走这条路。
    if req.uri().path().starts_with("/api/") {
        if req.headers().contains_key(header::ORIGIN) {
            return deny("FORBIDDEN_ORIGIN", "本机 API 不接受来自网页的调用。");
        }
        let api = state.api.lock().await;
        if !api.enabled || api.token.is_empty() {
            return deny("API_DISABLED", "本机 API 没有开启。在工作台的设置里打开。");
        }
        if !token_matches(bearer(&req), &api.token) {
            return unauthorized("缺少或错误的 API 令牌。");
        }
        drop(api);
        let level = ApiLevel::parse(&state.cloud.api_level().await);
        if level == ApiLevel::Off {
            return deny("API_PLAN", "当前档位不包含本机 API。");
        }
        if !allows(level, req.method().as_str(), req.uri().path()) {
            return deny(
                "API_SCOPE",
                "当前档位的本机 API 是只读的，不能启动或停止环境。",
            );
        }
        return next.run(req).await;
    }

    // 2. 有 Origin 就必须在名单里。网页发来的请求一定带 Origin。
    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        if !APP_ORIGINS.contains(&origin) {
            return deny("FORBIDDEN_ORIGIN", "这个来源不允许调用本机接口。");
        }
    }

    // 健康检查不需要令牌，但也只回一个字：探活用，不泄露任何内核或环境信息。
    if req.uri().path() == "/v1/health" {
        return next.run(req).await;
    }

    // 3. 令牌
    if !token_matches(bearer(&req), &state.token) {
        return unauthorized("缺少或错误的本机令牌。");
    }

    // 4. 团队里的角色。记在本机，所以拔了网线再来也是这个答案。
    if operator_blocked(req.method(), req.uri().path()) && state.role() == "operator" {
        return deny(
            "ROLE_FORBIDDEN",
            "你在这个团队里是操作员：可以打开分配给你的环境，但不能改团队的配置、也不能导出。",
        );
    }
    next.run(req).await
}

fn bearer(req: &Request) -> &str {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .strip_prefix("Bearer ")
        .unwrap_or("")
}

fn unauthorized(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "code": "UNAUTHORIZED", "message": message })),
    )
        .into_response()
}

fn api_token_path(paths: &HostPaths) -> PathBuf {
    paths.root.join("api.token")
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn kernel_view(State(state): State<Arc<App>>) -> Json<Value> {
    let slots = state.kernels.lock().await.clone();
    let mut kernels = Vec::new();
    for slot in &slots {
        kernels.push(json!({
            "record": slot.record,
            "withdrawn": slot.withdrawn,
            "status": slot.current_status(&state.paths).await,
        }));
    }
    let records: Vec<KernelRecord> = slots
        .iter()
        .filter(|s| !s.withdrawn)
        .map(|s| s.record.clone())
        .collect();
    prune_dead(&state.paths, &state.runtimes).await;
    let runtimes: Vec<RuntimeRow> = state.runtimes.lock().await.values().cloned().collect();
    Json(json!({
        "kernels": kernels,
        // 内核分两类，每一类有自己的默认版本；这一类在这个系统上一个版本都没有时是 null。
        "defaultVersions": {
            "chromium": default_version(&records, Engine::Chromium),
            "firefox": default_version(&records, Engine::Firefox),
        },
        "capabilities": capabilities(),
        "runtimes": runtimes,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdmitBody {
    version: String,
    /// 内核不是 stable 通道时，必须由用户在安全中心明确同意。
    #[serde(default)]
    allow_preview_channel: bool,
}

async fn kernel_admit(State(state): State<Arc<App>>, Json(body): Json<AdmitBody>) -> Json<Value> {
    let Some(slot) = state.slot(&body.version).await else {
        return unknown_kernel(&body.version);
    };
    if slot.withdrawn {
        return Json(json!({
            "ok": false,
            "code": "KERNEL_WITHDRAWN",
            "message": "这个版本已经下架，不能再下载。",
        }));
    }
    if slot.record.channel != "stable" && !body.allow_preview_channel {
        return Json(json!({
            "ok": false,
            "code": "KERNEL_CHANNEL_BLOCKED",
            "message": "这个内核还是预览通道，需要在安全中心明确同意后才能准入。",
        }));
    }
    {
        let mut flag = slot.admitting.lock().await;
        if *flag {
            return Json(json!(slot.status.lock().await.clone()));
        }
        *flag = true;
    }
    let paths = state.paths.clone();
    let task = slot.clone();
    tokio::spawn(async move {
        if let Err(e) = admit(&paths, &task.record, &task.status).await {
            let mut s = task.status.lock().await;
            if s.state != "hash_mismatch" {
                s.state = "error".into();
                s.error = Some(format!("内核没能下载或解压，检查网络后重试。（{e}）"));
            }
        } else {
            // 准入过程本身刚做过全量校验，本进程内不必立刻再做一次。
            task.verified_once.store(true, Ordering::Relaxed);
        }
        *task.admitting.lock().await = false;
    });
    let status = slot.status.lock().await.clone();
    Json(json!(status))
}

#[derive(Deserialize)]
struct RemoveBody {
    version: String,
}

/// 删掉一个已下载的版本，腾磁盘。正在下载的、还有环境在跑的不许删。
async fn kernel_remove(State(state): State<Arc<App>>, Json(body): Json<RemoveBody>) -> Json<Value> {
    let Some(slot) = state.slot(&body.version).await else {
        return unknown_kernel(&body.version);
    };
    if *slot.admitting.lock().await {
        return Json(json!({
            "ok": false,
            "code": "KERNEL_BUSY",
            "message": "这个版本正在下载或校验，等它结束再删。",
        }));
    }
    prune_dead(&state.paths, &state.runtimes).await;
    let in_use = state
        .runtimes
        .lock()
        .await
        .values()
        .filter(|r| r.kernel_version == body.version)
        .count();
    if in_use > 0 {
        return Json(json!({
            "ok": false,
            "code": "KERNEL_IN_USE",
            "message": format!("还有 {in_use} 个环境在用这个版本运行，先停掉它们。"),
        }));
    }
    if let Err(e) = remove_kernel(&state.paths, &slot.record).await {
        return Json(
            json!({ "ok": false, "code": "KERNEL_REMOVE_FAILED", "message": e.to_string() }),
        );
    }
    slot.verified_once.store(false, Ordering::Relaxed);
    *slot.status.lock().await = read_status_fast(&state.paths, &slot.record).await;
    if slot.withdrawn {
        // 下架的版本删掉之后就没有留在列表里的理由了。
        state
            .kernels
            .lock()
            .await
            .retain(|s| !Arc::ptr_eq(s, &slot));
    }
    Json(json!({ "ok": true }))
}

/// 去服务器取一次管理员上架的内核清单。信不信由 accept_feed 里的验签决定，不由它从哪来决定。
async fn sync_feed(state: &App) -> Result<usize, (String, String)> {
    let signed = state
        .cloud
        .kernel_feed()
        .await
        .map_err(|e| (e.code, e.message))?;
    state.accept_feed(&signed).await.map_err(|e| {
        (
            "KERNEL_LIST_REJECTED".to_string(),
            format!("内核清单没通过校验：{e:#}"),
        )
    })
}

async fn kernel_feed(State(state): State<Arc<App>>) -> Json<Value> {
    match sync_feed(&state).await {
        Ok(count) => Json(json!({ "ok": true, "count": count })),
        Err((code, message)) => Json(json!({ "ok": false, "code": code, "message": message })),
    }
}

/// 后台的一条循环：每 20 秒给正在跑的环境续租约，每半小时取一次内核清单。
async fn keep_leases(state: Arc<App>) {
    let mut round: u32 = 0;
    loop {
        if round.is_multiple_of(90) {
            let _ = sync_feed(&state).await;
        }
        round = round.wrapping_add(1);
        tokio::time::sleep(HEARTBEAT).await;
        prune_dead(&state.paths, &state.runtimes).await;
        let alive: HashSet<String> = state.runtimes.lock().await.keys().cloned().collect();
        // 租约丢了：这个环境已经归别的电脑，或者这台电脑被解绑了。停掉它，两边不能同时开着。
        for env_id in state.cloud.tick(&alive).await {
            let _ = stop_environment(&state.paths, &env_id, &state.runtimes, &state.bridges).await;
        }
    }
}

/* ── 环境、代理、密码：真相在 Host ─────────────────────────── */

fn refuse(code: &str, message: impl std::fmt::Display) -> Json<Value> {
    Json(json!({ "ok": false, "code": code, "message": message.to_string() }))
}

/// 页面启动时拉一次：全部环境、全部代理、哪些代理存了密码（只有 id，没有密码本身）。
async fn store_all(State(state): State<Arc<App>>) -> Json<Value> {
    let all = (|| -> anyhow::Result<Value> {
        Ok(json!({
            "ok": true,
            "environments": state.store.list(Kind::Environment)?,
            "proxies": state.store.list(Kind::Proxy)?,
            "workflows": state.store.list(Kind::Workflow)?,
            "secretIds": state.store.secret_ids()?,
        }))
    })();
    all.map(Json)
        .unwrap_or_else(|e| refuse("STORE_FAILED", format!("读不出本机数据：{e:#}")))
}

fn put_doc(state: &App, kind: Kind, id: &str, doc: &Value) -> Json<Value> {
    match state.store.put(kind, id, doc) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => refuse("STORE_FAILED", format!("没存上：{e:#}")),
    }
}

async fn env_put(
    State(state): State<Arc<App>>,
    Path(id): Path<String>,
    Json(doc): Json<Value>,
) -> Json<Value> {
    put_doc(&state, Kind::Environment, &id, &doc)
}

async fn env_delete(State(state): State<Arc<App>>, Path(id): Path<String>) -> Json<Value> {
    match state.store.delete(Kind::Environment, &id) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => refuse("STORE_FAILED", format!("没删掉：{e:#}")),
    }
}

async fn proxy_put(
    State(state): State<Arc<App>>,
    Path(id): Path<String>,
    Json(doc): Json<Value>,
) -> Json<Value> {
    put_doc(&state, Kind::Proxy, &id, &doc)
}

async fn proxy_delete(State(state): State<Arc<App>>, Path(id): Path<String>) -> Json<Value> {
    match state.store.delete(Kind::Proxy, &id) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => refuse("STORE_FAILED", format!("没删掉：{e:#}")),
    }
}

async fn workflow_put(
    State(state): State<Arc<App>>,
    Path(id): Path<String>,
    Json(doc): Json<Value>,
) -> Json<Value> {
    put_doc(&state, Kind::Workflow, &id, &doc)
}

async fn workflow_delete(State(state): State<Arc<App>>, Path(id): Path<String>) -> Json<Value> {
    match state.store.delete(Kind::Workflow, &id) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => refuse("STORE_FAILED", format!("没删掉：{e:#}")),
    }
}

const LOCKED: (&str, &str) = ("VAULT_LOCKED", "应用锁锁着，先输入口令。");

#[derive(Deserialize)]
struct SecretBody {
    value: String,
}

/// 密码只进不出：可以写、可以删，没有读回明文的接口。
async fn secret_put(
    State(state): State<Arc<App>>,
    Path(id): Path<String>,
    Json(body): Json<SecretBody>,
) -> Json<Value> {
    let vault = state.vault.lock().await;
    let Some(key) = vault.key() else {
        return refuse(LOCKED.0, LOCKED.1);
    };
    match state.store.put_secret(key, &id, &body.value) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => refuse("STORE_FAILED", format!("密码没存上：{e:#}")),
    }
}

async fn secret_delete(State(state): State<Arc<App>>, Path(id): Path<String>) -> Json<Value> {
    match state.store.delete_secret(&id) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => refuse("STORE_FAILED", format!("没删掉：{e:#}")),
    }
}

#[derive(Deserialize)]
struct ExportBody {
    passphrase: String,
}

/// 要把密码带到另一台电脑：用用户给的导出口令单独加密后交出去。明文不经过页面。
async fn secrets_export(
    State(state): State<Arc<App>>,
    Json(body): Json<ExportBody>,
) -> Json<Value> {
    let vault = state.vault.lock().await;
    let Some(key) = vault.key() else {
        return refuse(LOCKED.0, LOCKED.1);
    };
    if body.passphrase.trim().is_empty() {
        return refuse("BAD_PASSPHRASE", "导出口令不能为空。");
    }
    let sealed = state
        .store
        .all_secrets(key)
        .and_then(|all| Ok((all.len(), vault::seal_export(body.passphrase.trim(), &all)?)));
    match sealed {
        Ok((0, _)) => Json(json!({ "ok": true, "count": 0 })),
        Ok((count, sealed)) => Json(json!({ "ok": true, "count": count, "sealed": sealed })),
        Err(e) => refuse("STORE_FAILED", format!("导出失败：{e:#}")),
    }
}

#[derive(Deserialize)]
struct ImportBody {
    passphrase: String,
    sealed: vault::SealedSecrets,
}

async fn secrets_import(
    State(state): State<Arc<App>>,
    Json(body): Json<ImportBody>,
) -> Json<Value> {
    let vault = state.vault.lock().await;
    let Some(key) = vault.key() else {
        return refuse(LOCKED.0, LOCKED.1);
    };
    let secrets = match vault::open_export(body.passphrase.trim(), &body.sealed) {
        Ok(s) => s,
        Err(_) => {
            return refuse(
                "BAD_PASSPHRASE",
                "导出口令不对，密码没有导入。其余配置不受影响。",
            )
        }
    };
    let mut count = 0;
    for (id, value) in &secrets {
        if store::valid_id(id) && state.store.put_secret(key, id, value).is_ok() {
            count += 1;
        }
    }
    Json(json!({ "ok": true, "count": count, "ids": state.store.secret_ids().unwrap_or_default() }))
}

/* ── 应用锁 ───────────────────────────────────────────────── */

async fn vault_view(State(state): State<Arc<App>>) -> Json<Value> {
    let vault = state.vault.lock().await;
    Json(json!({ "ok": true, "appLock": vault.app_lock(), "unlocked": vault.unlocked() }))
}

#[derive(Deserialize)]
struct PassphraseBody {
    #[serde(default)]
    passphrase: Option<String>,
}

async fn vault_unlock(
    State(state): State<Arc<App>>,
    Json(body): Json<PassphraseBody>,
) -> Json<Value> {
    let mut vault = state.vault.lock().await;
    match vault.unlock(body.passphrase.as_deref().unwrap_or("")) {
        Ok(()) => Json(json!({ "ok": true, "appLock": true, "unlocked": true })),
        Err(_) => refuse("VAULT_BAD_PASSPHRASE", "口令不对。"),
    }
}

async fn vault_lock(State(state): State<Arc<App>>) -> Json<Value> {
    let mut vault = state.vault.lock().await;
    vault.lock();
    Json(json!({ "ok": true, "appLock": vault.app_lock(), "unlocked": vault.unlocked() }))
}

/// 给口令 = 开应用锁（或换口令）；不给 = 关掉。两样都要先解锁。
async fn vault_app_lock(
    State(state): State<Arc<App>>,
    Json(body): Json<PassphraseBody>,
) -> Json<Value> {
    let mut vault = state.vault.lock().await;
    let done = match body.passphrase.as_deref() {
        Some(p) => vault.enable_app_lock(p),
        None => vault.disable_app_lock(),
    };
    match done {
        Ok(()) => {
            Json(json!({ "ok": true, "appLock": vault.app_lock(), "unlocked": vault.unlocked() }))
        }
        Err(e) => refuse("VAULT_FAILED", format!("{e:#}")),
    }
}

/// 忘了口令：换一把新的数据密钥，旧钥匙加密的代理密码一起清掉。环境和代理本身不受影响。
async fn vault_reset(State(state): State<Arc<App>>) -> Json<Value> {
    let mut vault = state.vault.lock().await;
    if let Err(e) = state.store.clear_secrets().and_then(|()| vault.reset()) {
        return refuse("VAULT_FAILED", format!("{e:#}"));
    }
    Json(json!({ "ok": true, "appLock": false, "unlocked": true }))
}

/* ── 同步密钥的交接 ───────────────────────────────────────────
这里是"两台设备之间"的事：服务器只转交包装。数据密钥的明文从不离开这台电脑。 */

/// 这台设备的长期密钥对。第一次用到时生成并存进系统钥匙串。
async fn device_key(state: &App) -> Result<enclave_host::sync::DeviceKey, Json<Value>> {
    enclave_host::sync::DeviceKey::load(&state.paths.root)
        .map_err(|e| refuse("SYNC_FAILED", format!("设备密钥用不了：{e:#}")))
}

fn cloud_err(e: enclave_host::cloud::CloudError) -> Json<Value> {
    Json(e.json())
}

/// 工作台据此显示：还没开同步 / 这台电脑在等批准 / 已经在同步。
/// 顺带把这台设备的公钥登记上去——服务器要靠它才知道该给谁包。
async fn sync_view(State(state): State<Arc<App>>) -> Json<Value> {
    let key = match device_key(&state).await {
        Ok(k) => k,
        Err(e) => return e,
    };
    let public = key.public_b64();
    let mut view = match state.cloud.sync_get("/v1/sync").await {
        Ok(v) => v,
        Err(e) => return cloud_err(e),
    };
    // 公钥没登记过、或者和这台电脑现在这把对不上，就登记一次。
    if view["digits"].as_str() != Some(&enclave_host::sync::pairing_digits(&public)) {
        match state
            .cloud
            .sync_post("/v1/sync/register", json!({ "publicKey": public }))
            .await
        {
            Ok(v) => view["digits"] = v["digits"].clone(),
            Err(e) => return cloud_err(e),
        }
    }
    view["ok"] = json!(true);
    view["publicKey"] = json!(public);
    Json(view)
}

/// 第一台设备开启同步：把现在这把数据密钥包两份交上去——一份给自己，一份用恢复码包。
/// 恢复码只在这里出现这一次。
async fn sync_enable(State(state): State<Arc<App>>) -> Json<Value> {
    let device = match device_key(&state).await {
        Ok(k) => k,
        Err(e) => return e,
    };
    let dk = {
        let vault = state.vault.lock().await;
        match vault.key() {
            Some(k) => *k,
            None => return refuse(LOCKED.0, LOCKED.1),
        }
    };
    // 先让服务器认识这台设备的公钥。
    if let Err(e) = state
        .cloud
        .sync_post(
            "/v1/sync/register",
            json!({ "publicKey": device.public_b64() }),
        )
        .await
    {
        return cloud_err(e);
    }
    let code = enclave_host::sync::new_recovery_code();
    let built = enclave_host::sync::seal_recovery(&code, &dk).and_then(|rec| {
        Ok((
            rec,
            enclave_host::sync::seal_for(&device.public_b64(), &dk)?,
        ))
    });
    let (rec, (ephemeral, sealed)) = match built {
        Ok(v) => v,
        Err(e) => return refuse("SYNC_FAILED", format!("包不起来：{e:#}")),
    };
    let key_id = enclave_host::sync::new_key_id();
    let body = json!({
        "keyId": key_id,
        "recoverySalt": rec.salt, "recoveryParams": rec.params, "recoveryBox": rec.sealed,
        "ephemeral": ephemeral, "box": sealed,
    });
    match state.cloud.sync_post("/v1/sync/enable", body).await {
        // 恢复码只在这一次交给用户，服务器那边只有包装。开启之后把本机已有的东西传上去。
        Ok(_) => {
            let _ = state.store.mark_all_pending();
            let _ = sync_once(&state).await;
            Json(json!({ "ok": true, "keyId": key_id, "recoveryCode": code }))
        }
        Err(e) => cloud_err(e),
    }
}

/// 还在等批准的设备。每台带一串 6 位数字，用户拿它和那台电脑上显示的对。
async fn sync_pending(State(state): State<Arc<App>>) -> Json<Value> {
    match state.cloud.sync_get("/v1/sync/pending").await {
        Ok(v) => Json(v),
        Err(e) => cloud_err(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApproveBody {
    device_id: String,
    public_key: String,
    /// 用户在这台电脑上看到、并和对方核对过的那串数字。
    digits: String,
}

/// 批准另一台设备：用它的公钥把数据密钥包好交给服务器。
/// 再核一遍数字：服务器要是把公钥换成了别的，这里就对不上，不会包给它。
async fn sync_approve(State(state): State<Arc<App>>, Json(body): Json<ApproveBody>) -> Json<Value> {
    if enclave_host::sync::pairing_digits(&body.public_key) != body.digits.trim() {
        return refuse(
            "SYNC_DIGITS_MISMATCH",
            "这台设备的校验码对不上，没有把密钥给它。请在两台电脑上重新核对。",
        );
    }
    let dk = {
        let vault = state.vault.lock().await;
        match vault.key() {
            Some(k) => *k,
            None => return refuse(LOCKED.0, LOCKED.1),
        }
    };
    let (ephemeral, sealed) = match enclave_host::sync::seal_for(&body.public_key, &dk) {
        Ok(v) => v,
        Err(e) => return refuse("SYNC_FAILED", format!("包不起来：{e:#}")),
    };
    let payload = json!({ "deviceId": body.device_id, "ephemeral": ephemeral, "box": sealed });
    // 不管走哪条路，都先把这台设备的公钥钉下来：以后自动给它发环境钥匙只认这一份，
    // 服务器把公钥换成别的就不发，等用户重新核对数字。
    let _ = state.store.pin_device(&body.device_id, &body.public_key);
    match state.cloud.sync_post("/v1/sync/approve", payload).await {
        Ok(_) => Json(json!({ "ok": true })),
        // 操作员的电脑不拿团队密钥：批准它只是"认下这把公钥"，
        // 分配给他的那几个环境的钥匙由下一轮同步发过去。
        Err(e) if e.code == "OPERATOR_DEVICE" => Json(json!({ "ok": true, "operator": true })),
        Err(e) => {
            let _ = state.store.unpin_device(&body.device_id);
            cloud_err(e)
        }
    }
}

/// 把解出来的密钥收下：本机已经加密的东西先用旧钥匙解出来、用新钥匙写回去，再换钥匙。
async fn adopt(state: &App, dk: enclave_host::vault::DataKey) -> Json<Value> {
    let mut vault = state.vault.lock().await;
    let Some(old) = vault.key().copied() else {
        return refuse(LOCKED.0, LOCKED.1);
    };
    if old == dk {
        return Json(json!({ "ok": true, "rekeyed": 0 }));
    }
    let rekeyed = match state.store.rekey(&old, &dk) {
        Ok(n) => n,
        Err(e) => return refuse("SYNC_FAILED", format!("本机已保存的密码换不过去：{e:#}")),
    };
    // 换了钥匙：本机所有东西都要用新钥匙重新传一遍，否则另一台拉下来解不开。
    let _ = state.store.mark_all_pending();
    match vault.replace_key(dk) {
        Ok(()) => Json(json!({ "ok": true, "rekeyed": rekeyed })),
        Err(e) => refuse("SYNC_FAILED", format!("{e:#}")),
    }
}

/// 这台设备被批准之后：取回属于自己的那一份，拆开，收下。
async fn sync_adopt(State(state): State<Arc<App>>) -> Json<Value> {
    let device = match device_key(&state).await {
        Ok(k) => k,
        Err(e) => return e,
    };
    let view = match state.cloud.sync_get("/v1/sync").await {
        Ok(v) => v,
        Err(e) => return cloud_err(e),
    };
    let (Some(ephemeral), Some(sealed)) = (
        view.pointer("/envelope/ephemeral").and_then(Value::as_str),
        view.pointer("/envelope/box").and_then(Value::as_str),
    ) else {
        return refuse("SYNC_NOT_APPROVED", "另一台电脑还没有批准这台。");
    };
    match device.unseal(ephemeral, sealed) {
        Ok(dk) => adopt(&state, dk).await,
        Err(e) => refuse("SYNC_FAILED", format!("拆不开交过来的密钥：{e:#}")),
    }
}

#[derive(Deserialize)]
struct RecoverBody {
    code: String,
}

/// 手边一台已经登录过的电脑都没有了：用恢复码解开另一份包装。
async fn sync_recover(State(state): State<Arc<App>>, Json(body): Json<RecoverBody>) -> Json<Value> {
    let view = match state.cloud.sync_get("/v1/sync").await {
        Ok(v) => v,
        Err(e) => return cloud_err(e),
    };
    let boxed = enclave_host::sync::RecoveryBox {
        salt: view
            .pointer("/recovery/salt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        params: view
            .pointer("/recovery/params")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        sealed: view
            .pointer("/recovery/box")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
    };
    if boxed.sealed.is_empty() {
        return refuse("SYNC_OFF", "这个账号还没有开启同步。");
    }
    match enclave_host::sync::open_recovery(&body.code, &boxed) {
        Ok(dk) => {
            let done = adopt(&state, dk).await;
            // 收下之后顺手把这台设备也登记进去，下次换电脑就能从这台批准。
            if done.0["ok"] == true {
                if let Ok(device) = enclave_host::sync::DeviceKey::load(&state.paths.root) {
                    let _ = state
                        .cloud
                        .sync_post(
                            "/v1/sync/register",
                            json!({ "publicKey": device.public_b64() }),
                        )
                        .await;
                    if let Ok((ephemeral, sealed)) =
                        enclave_host::sync::seal_for(&device.public_b64(), &dk)
                    {
                        let _ = state
                            .cloud
                            .sync_post(
                                "/v1/sync/approve",
                                json!({ "deviceId": view["deviceId"], "ephemeral": ephemeral, "box": sealed }),
                            )
                            .await;
                    }
                }
            }
            done
        }
        Err(_) => refuse("SYNC_BAD_CODE", "恢复码不对。"),
    }
}

/// 环境要停了：趁浏览器还活着，把登录态导出来、加密传上去。
/// 任何一步不成都只是这一次没传上——环境照常停，版本已经记下，下次再传。
async fn save_cookies(state: &App, env_id: &str) {
    let Some(rt) = state.runtimes.lock().await.get(env_id).cloned() else {
        return;
    };
    // 用户把这个环境设成了「只留在这台电脑上」。
    if state.store.local_only(env_id) {
        return;
    }
    let Ok(jar) = enclave_host::cookies::export(rt.engine, rt.port).await else {
        return;
    };
    if enclave_host::cookies::count_check(&jar).is_err() {
        return;
    }
    let Ok(packed) = jar.pack() else { return };
    if state.store.bump_cookies(env_id).is_err() {
        return;
    }
    // 传不上去不影响停止：版本已经记下了。但要留一行，不然这种失败在日志里毫无痕迹。
    if let Err(why) = upload_cookies(state, env_id, packed).await {
        eprintln!("环境 {env_id} 的登录态没传上去：{why}");
    }
}

/// 启动之后、把浏览器交给用户之前：云端有更新的登录态就取下来放进去。
/// 取不到、解不开都不拦启动——用户得到的是一个需要重新登录的浏览器，而不是一个打不开的。
async fn restore_cookies(state: &App, env_id: &str, engine: Engine, port: u16) -> Option<usize> {
    if state.store.local_only(env_id) {
        return None;
    }
    let slot = env_key(state, env_id).await?;
    let list = state.cloud.sync_get("/v1/sync/blobs").await.ok()?;
    let mine = state.store.cookie_version(env_id);
    let row = list["blobs"]
        .as_array()?
        .iter()
        .find(|b| b["envId"].as_str() == Some(env_id))?;
    let version = row["version"].as_i64()?;
    // 本机这一份一样新或更新：别用云端的盖掉。
    if version <= mine {
        return None;
    }
    let sealed = state.cloud.get_blob(row["url"].as_str()?).await.ok()?;
    let packed = enclave_host::sync::open_blob(
        &slot.key,
        row["keyId"].as_str().unwrap_or_default(),
        env_id,
        version,
        &sealed,
    )
    .ok()?;
    let jar = enclave_host::cookies::Jar::unpack(&packed).ok()?;
    let put = enclave_host::cookies::import(engine, port, &jar)
        .await
        .ok()?;
    let _ = state.store.set_cookie_version(env_id, version);
    Some(put)
}

/// 把一包登录态加密后传上去，并向服务器登记版本。用的是这个环境自己那把钥匙。
async fn upload_cookies(state: &App, env_id: &str, packed: Vec<u8>) -> Result<(), String> {
    let Some(slot) = env_key(state, env_id).await else {
        // 同步没开、钥匙还没发到这台电脑：这一份先留在本机，下次再传。
        return Ok(());
    };
    let version = state.store.cookie_version(env_id);
    upload_packed(state, env_id, &slot, version, packed).await
}

/// 这台电脑现在手里有没有这个环境的钥匙。
async fn env_key(state: &App, env_id: &str) -> Option<enclave_host::slots::SlotKey> {
    let view = state.cloud.sync_get("/v1/sync").await.ok()?;
    if view["enabled"] != true {
        return None;
    }
    let holds_team_key = view["holdsTeamKey"] != false;
    let dk = if holds_team_key {
        let vault = state.vault.lock().await;
        Some(*vault.key()?)
    } else {
        None
    };
    let device = DeviceKey::load(&state.paths.root).ok()?;
    let slots = state.cloud.sync_get("/v1/sync/slots").await.ok()?;
    Keyring::build(&slots, dk.as_ref(), &device)
        .env(env_id)
        .cloned()
}

/// 加密、上传、登记。换钥匙之后重传用的也是这一条路。
async fn upload_packed(
    state: &App,
    env_id: &str,
    slot: &enclave_host::slots::SlotKey,
    version: i64,
    packed: Vec<u8>,
) -> Result<(), String> {
    let sealed = enclave_host::sync::seal_blob(&slot.key, &slot.key_id, env_id, version, &packed)
        .map_err(|e| e.to_string())?;
    let issued = state
        .cloud
        .sync_post(
            "/v1/sync/blob/upload",
            json!({ "envId": env_id, "version": version, "keyId": slot.key_id, "bytes": sealed.len() }),
        )
        .await
        .map_err(|e| e.message)?;
    let url = issued["url"].as_str().unwrap_or_default().to_string();
    state
        .cloud
        .put_blob(&url, sealed)
        .await
        .map_err(|e| e.message)?;
    state
        .cloud
        .sync_post(
            "/v1/sync/blob/commit",
            json!({ "envId": env_id, "version": version, "keyId": slot.key_id }),
        )
        .await
        .map_err(|e| e.message)?;
    state
        .store
        .mark_cookies_synced(env_id, version)
        .map_err(|e| e.to_string())
}

/// 跑一轮同步：先把本机改过的推上去，再把云端更新的拉下来。
/// 两边都是密文进密文出——加密解密只在这里做。
/// 一条文档归哪把钥匙管。和服务器（Go 的 docSlot）算的是同一件事。
fn doc_slot(kind: Kind, id: &str) -> String {
    match kind {
        Kind::Environment => enclave_host::sync::env_slot(id),
        Kind::Proxy | Kind::Workflow => enclave_host::sync::SHARED_SLOT.to_string(),
    }
}

/// 拿得到团队密钥的电脑每轮同步都做这三件事：
///   1. 本机有环境、云端还没有它的钥匙 → 建一把；
///   2. 服务器说某几把该换了（有人被移出团队）→ 换新的，并把那几个环境重新加密；
///   3. 有人等着钥匙 → 用他那台设备的公钥包一份交给服务器转交。
///
/// 全程只动"该动的那几个环境"，别的环境和别的成员一个字节都不用重传。
async fn tend_slots(
    state: &App,
    dk: &enclave_host::vault::DataKey,
    device: &DeviceKey,
    ring: &mut Keyring,
) -> Result<(usize, usize), String> {
    use enclave_host::slots::mint;

    // 1 + 2：该建的建，该换的换。
    let mut want: Vec<String> = vec![enclave_host::sync::SHARED_SLOT.to_string()];
    for env in state
        .store
        .list(Kind::Environment)
        .map_err(|e| e.to_string())?
    {
        if let Some(id) = env["id"].as_str() {
            want.push(enclave_host::sync::env_slot(id));
        }
    }
    let mut rotated = 0usize;
    let mut settled: Vec<String> = Vec::new();
    for slot in &want {
        let stale = ring.stale.contains(slot);
        if ring.get(slot).is_some() && !stale {
            continue;
        }
        let old = ring.get(slot).cloned();
        let (fresh, boxed) = mint(dk, slot).map_err(|e| e.to_string())?;
        state
            .cloud
            .sync_put(
                "/v1/sync/slots",
                json!({ "slot": slot, "keyId": fresh.key_id, "boxTeam": boxed }),
            )
            .await
            .map_err(|e| e.message)?;
        ring.insert(slot.clone(), fresh.clone());
        if stale {
            rotated += 1;
            settled.push(slot.clone());
            rekey_slot(state, slot, old.as_ref(), &fresh).await;
        }
    }
    if !settled.is_empty() {
        let _ = state
            .cloud
            .sync_post("/v1/sync/settled", json!({ "slots": settled }))
            .await;
    }
    // 刚换过钥匙：服务器那份"还缺哪些钥匙"的清单里写的是旧编号，按它发会对不上。
    // 重新取一次，拿到的就是新编号下还缺的那些。
    if rotated > 0 {
        if let Ok(view) = state.cloud.sync_get("/v1/sync/slots").await {
            let fresh = Keyring::build(&view, Some(dk), device);
            ring.wanted = fresh.wanted;
        }
    }

    // 3：把钥匙发给等着的人。核对数字：服务器换了公钥就不发。
    let mut granted = 0usize;
    for w in &ring.wanted {
        let Some(slot) = ring.get(&w.slot) else {
            continue;
        };
        if slot.key_id != w.key_id
            || enclave_host::sync::pairing_digits(&w.public_key) != w.digits
            || !state.store.device_pinned(&w.device_id, &w.public_key)
        {
            // 这台设备的公钥和批准时记下的对不上：不发，等用户重新核对。
            continue;
        }
        let Ok((ephemeral, boxed)) = enclave_host::sync::seal_for(&w.public_key, &slot.key) else {
            continue;
        };
        if state
            .cloud
            .sync_post(
                "/v1/sync/grants",
                json!({
                    "slot": w.slot, "keyId": slot.key_id, "deviceId": w.device_id,
                    "ephemeral": ephemeral, "box": boxed, "digits": w.digits,
                }),
            )
            .await
            .is_ok()
        {
            granted += 1;
        }
    }
    let _ = device; // 发钥匙只用得到对方的公钥，自己的私钥这里用不上。
    Ok((rotated, granted))
}

/// 代理密码的同步。用的是大家共用的那把钥匙（`shared`）——操作员也要用代理。
///
/// 明文在这台电脑的保险箱里（用本机的数据密钥加密）；上云之前换成共用钥匙加密，
/// 拉下来之后再换回本机的。服务器两头都解不开，界面两头都读不回明文。
async fn sync_secrets(state: &App, ring: &Keyring) -> Result<(usize, usize), String> {
    let slot = ring
        .get(enclave_host::sync::SHARED_SLOT)
        .ok_or("还没拿到大家共用的那把钥匙")?;
    let local = {
        let vault = state.vault.lock().await;
        *vault.key().ok_or(LOCKED.1)?
    };
    const KIND: &str = enclave_host::store::SECRET_KIND;

    // 推：本机改过的。
    let mut pushed = 0usize;
    let pending = state.store.pending_secrets().map_err(|e| e.to_string())?;
    let mut docs = Vec::new();
    for (id, version, deleted) in &pending {
        let boxed = if *deleted {
            String::new()
        } else {
            let Some(value) = state
                .store
                .secret(&local, id)
                .map_err(|e| format!("{id} 解不开：{e}"))?
            else {
                continue;
            };
            enclave_host::sync::seal_doc(
                &slot.key,
                &slot.key_id,
                KIND,
                id,
                *version,
                value.as_bytes(),
            )
            .map_err(|e| e.to_string())?
        };
        docs.push(json!({
            "kind": KIND, "id": id, "version": version,
            "keyId": slot.key_id, "box": boxed, "deleted": deleted,
        }));
    }
    if !docs.is_empty() {
        // 传不上去要当场说出来。吞掉错误的话，表现就是"密码永远同步不过去"而日志里一片干净。
        let res = state
            .cloud
            .sync_post("/v1/sync/docs", json!({ "docs": docs }))
            .await
            .map_err(|e| e.message)?;
        {
            let stale: Vec<String> = res["stale"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            for (id, version, _) in &pending {
                if !stale.contains(&format!("{KIND}/{id}")) {
                    let _ = state.store.mark_secret_synced(id, *version);
                    pushed += 1;
                }
            }
        }
    }

    // 拉：云端比本机新的。
    let mut pulled = 0usize;
    let remote = state
        .cloud
        .sync_get("/v1/sync/docs")
        .await
        .map_err(|e| e.message)?;
    let mine = state.store.secret_versions().map_err(|e| e.to_string())?;
    for d in remote["docs"].as_array().cloned().unwrap_or_default() {
        if d["kind"].as_str() != Some(KIND) {
            continue;
        }
        let (Some(id), Some(version)) = (d["id"].as_str(), d["version"].as_i64()) else {
            continue;
        };
        if mine.get(id).is_some_and(|v| *v >= version) {
            continue;
        }
        if d["deleted"] == true {
            if state.store.delete_secret_remote(id, version).is_ok() {
                pulled += 1;
            }
            continue;
        }
        let opened = enclave_host::sync::open_doc(
            &slot.key,
            d["keyId"].as_str().unwrap_or_default(),
            KIND,
            id,
            version,
            d["box"].as_str().unwrap_or_default(),
        )
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok());
        if let Some(value) = opened {
            if state
                .store
                .put_secret_remote(&local, id, &value, version)
                .is_ok()
            {
                pulled += 1;
            }
        }
    }
    Ok((pushed, pulled))
}

/// 换了钥匙之后，把这个槽位下的东西重新加密一遍。
/// 配置很小，本机就有明文，改一下版本号下一步就推上去了；
/// 登录态是大块头，能拿到旧钥匙就当场换，拿不到就删掉云端那一份——
/// 下一次有人用完这个环境会重新传一份新的上来，不会留着一份旧钥匙还能解开的。
async fn rekey_slot(
    state: &App,
    slot: &str,
    old: Option<&enclave_host::slots::SlotKey>,
    fresh: &enclave_host::slots::SlotKey,
) {
    let Some(env_id) = slot.strip_prefix("env:") else {
        // 共用那一包：所有代理、代理密码和流程都重新加密一遍。
        for kind in [Kind::Proxy, Kind::Workflow] {
            if let Ok(list) = state.store.list(kind) {
                for p in list {
                    if let Some(id) = p["id"].as_str() {
                        let _ = state.store.touch(kind, id);
                    }
                }
            }
        }
        if let Ok(ids) = state.store.secret_ids() {
            for id in ids {
                let _ = state.store.touch_secret(&id);
            }
        }
        return;
    };
    let _ = state.store.touch(Kind::Environment, env_id);

    // 登录态：下载、用旧钥匙解开、用新钥匙封回去。
    let reencrypted = async {
        let old = old?;
        let list = state.cloud.sync_get("/v1/sync/blobs").await.ok()?;
        let row = list["blobs"]
            .as_array()?
            .iter()
            .find(|b| b["envId"].as_str() == Some(env_id))?
            .clone();
        let version = row["version"].as_i64()?;
        let sealed = state.cloud.get_blob(row["url"].as_str()?).await.ok()?;
        let packed = enclave_host::sync::open_blob(
            &old.key,
            row["keyId"].as_str().unwrap_or_default(),
            env_id,
            version,
            &sealed,
        )
        .ok()?;
        let next = state.store.bump_cookies(env_id).ok()?;
        upload_packed(state, env_id, fresh, next, packed).await.ok()
    }
    .await;
    if reencrypted.is_none() {
        // 解不开或者传不上去：宁可让云端那一份消失，也不留着旧钥匙解得开的密文。
        let _ = state
            .cloud
            .sync_delete(&format!("/v1/sync/blobs/{env_id}"))
            .await;
    }
}

async fn sync_once(state: &App) -> Result<Value, String> {
    let view = state
        .cloud
        .sync_get("/v1/sync")
        .await
        .map_err(|e| e.message)?;
    if view["enabled"] != true {
        return Ok(json!({ "ok": true, "enabled": false }));
    }
    let holds_team_key = view["holdsTeamKey"] != false;
    // 所有者和管理员靠团队密钥；操作员没有团队密钥，只有一把把单独发给他的槽位钥匙。
    if holds_team_key && view["hasKey"] != true {
        return Ok(json!({ "ok": true, "enabled": true, "hasKey": false }));
    }
    let dk = if holds_team_key {
        let vault = state.vault.lock().await;
        Some(*vault.key().ok_or_else(|| LOCKED.1.to_string())?)
    } else {
        None
    };
    let device = DeviceKey::load(&state.paths.root).map_err(|e| e.to_string())?;

    // 0. 钥匙：这一轮我手里有哪些、哪些该换、该发给谁。
    let mut ring = {
        let view = state
            .cloud
            .sync_get("/v1/sync/slots")
            .await
            .map_err(|e| e.message)?;
        Keyring::build(&view, dk.as_ref(), &device)
    };
    let mut rotated = 0usize;
    let mut granted = 0usize;
    if let Some(dk) = dk.as_ref() {
        (rotated, granted) = tend_slots(state, dk, &device, &mut ring).await?;
    }
    if ring.is_empty() {
        // 一把钥匙都没有：新加入的操作员还等着团队里的电脑把钥匙发过来。
        return Ok(json!({ "ok": true, "enabled": true, "hasKey": false, "waitingForKeys": true }));
    }

    // 1. 推：本机改过、还没传上去的。
    let pending = state.store.pending().map_err(|e| e.to_string())?;
    let mut pushed = 0usize;
    let mut stale: Vec<String> = Vec::new();
    for chunk in pending.chunks(50) {
        let mut docs = Vec::new();
        for p in chunk {
            // 这一条归哪把钥匙管：环境各归各的，代理走共用的那一把。
            let Some(slot) = ring.get(&doc_slot(p.kind, &p.id)) else {
                continue; // 还没有这把钥匙（刚建的环境、或者没分给我）：这一轮先不传。
            };
            let boxed = match &p.doc {
                Some(doc) => {
                    let plain = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
                    enclave_host::sync::seal_doc(
                        &slot.key,
                        &slot.key_id,
                        p.kind.wire(),
                        &p.id,
                        p.version,
                        &plain,
                    )
                    .map_err(|e| e.to_string())?
                }
                None => String::new(),
            };
            docs.push(json!({
                "kind": p.kind.wire(), "id": p.id, "version": p.version,
                "keyId": slot.key_id, "box": boxed, "deleted": p.deleted,
            }));
        }
        if docs.is_empty() {
            continue;
        }
        let res = state
            .cloud
            .sync_post("/v1/sync/docs", json!({ "docs": docs }))
            .await
            .map_err(|e| e.message)?;
        let rejected: Vec<String> = res["stale"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        // 被挡下来的那几条等拉取时合并；其余的记成已传。
        let done: Vec<_> = chunk
            .iter()
            .filter(|p| !rejected.contains(&format!("{}/{}", p.kind.wire(), p.id)))
            .map(|p| (p.kind, p.id.clone(), p.version))
            .collect();
        pushed += done.len();
        state.store.mark_synced(&done).map_err(|e| e.to_string())?;
        stale.extend(rejected);
    }

    // 2. 拉：云端比本机新的。
    let remote = state
        .cloud
        .sync_get("/v1/sync/docs")
        .await
        .map_err(|e| e.message)?;
    let mine = state.store.versions().map_err(|e| e.to_string())?;
    let mut pulled = 0usize;
    let mut unreadable = 0usize;
    for d in remote["docs"].as_array().cloned().unwrap_or_default() {
        let (Some(kind_wire), Some(id), Some(version)) =
            (d["kind"].as_str(), d["id"].as_str(), d["version"].as_i64())
        else {
            continue;
        };
        let Some(kind) = Kind::parse(kind_wire) else {
            continue;
        };
        // 本机这条一样新或更新：留着本机的。
        // 例外是刚才推上去被挡下来的那几条：服务器上已经有别人写的同号版本，
        // 这时必须收下服务器那一份，否则两台电脑会各执一词、永远对不上。
        let slot = format!("{kind_wire}/{id}");
        let overruled = stale.contains(&slot);
        if !overruled
            && mine
                .get(&(kind_wire.to_string(), id.to_string()))
                .is_some_and(|v| *v >= version)
        {
            continue;
        }
        if d["deleted"] == true {
            state
                .store
                .delete_remote(kind, id, version)
                .map_err(|e| e.to_string())?;
            pulled += 1;
            continue;
        }
        // 没有这把钥匙（没分给我），或者钥匙换过了：跳过，不让它把本机的覆盖掉。
        let Some(slot_key) = ring.get(&doc_slot(kind, id)) else {
            unreadable += 1;
            continue;
        };
        let doc = enclave_host::sync::open_doc(
            &slot_key.key,
            d["keyId"].as_str().unwrap_or_default(),
            kind_wire,
            id,
            version,
            d["box"].as_str().unwrap_or_default(),
        );
        match doc
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        {
            Some(doc) => {
                state
                    .store
                    .put_remote(kind, id, &doc, version)
                    .map_err(|e| e.to_string())?;
                pulled += 1;
            }
            None => unreadable += 1,
        }
    }
    // 2.5 代理密码：团队里的操作员不许填密码，所以密码必须跟着代理一起到他电脑上。
    //     它用大家共用的那把钥匙加密之后才上云，服务器照样解不开；
    //     到了他的电脑上也只是存进保险箱——界面永远读不回明文。
    let (secrets_pushed, secrets_pulled) = match sync_secrets(state, &ring).await {
        Ok(counts) => counts,
        Err(why) => {
            // 密码没同步上不该让整轮同步失败，但必须留下痕迹：
            // 悄悄失败的同步是最难查的问题。
            eprintln!("代理密码这一轮没同步：{why}");
            (0, 0)
        }
    };

    // 3. 登录态：这里只做"清掉云端不该留的那几份"。上传发生在环境停止的时候——
    // 那时浏览器还活着，才导得出 Cookie。
    let mut removed = 0usize;
    if let Ok(list) = state.cloud.sync_get("/v1/sync/blobs").await {
        for b in list["blobs"].as_array().cloned().unwrap_or_default() {
            let Some(env_id) = b["envId"].as_str() else {
                continue;
            };
            // 环境已经删了，或者用户把它改成了「只留在这台电脑上」：云端那一份留着没有意义。
            let gone = state
                .store
                .get(Kind::Environment, env_id)
                .ok()
                .flatten()
                .is_none();
            if (gone || state.store.local_only(env_id))
                && state
                    .cloud
                    .sync_delete(&format!("/v1/sync/blobs/{env_id}"))
                    .await
                    .is_ok()
            {
                removed += 1;
            }
        }
    }
    Ok(json!({
        "ok": true, "enabled": true, "hasKey": true,
        "pushed": pushed, "pulled": pulled, "stale": stale.len(), "unreadable": unreadable,
        "cookiesRemoved": removed, "rotated": rotated, "granted": granted, "keys": ring.len(),
        "secretsPushed": secrets_pushed, "secretsPulled": secrets_pulled,
    }))
}

/// 云端存了哪些环境的登录态、一共多大。界面上给用户一个交代。
async fn sync_usage(State(state): State<Arc<App>>) -> Json<Value> {
    match state.cloud.sync_get("/v1/sync/blobs").await {
        Ok(v) => Json(v),
        Err(e) => cloud_err(e),
    }
}

async fn sync_run(State(state): State<Arc<App>>) -> Json<Value> {
    match sync_once(&state).await {
        Ok(v) => Json(v),
        Err(message) => refuse("SYNC_FAILED", message),
    }
}

/// 关掉同步。本机的数据密钥不动（代理密码还解得开），服务器上的包装和密文删掉。
async fn sync_disable(State(state): State<Arc<App>>) -> Json<Value> {
    match state.cloud.sync_post("/v1/sync/disable", json!({})).await {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => cloud_err(e),
    }
}

/* ── 账号与额度 ───────────────────────────────────────────── */

async fn session_view(State(state): State<Arc<App>>) -> Json<Value> {
    let view = state.cloud.view().await;
    // 服务器每说一次角色就记一次：断网之后按最后听到的那个算。
    if let Some(role) = view["role"].as_str() {
        let _ = state.store.set_meta("role", role);
    }
    Json(view)
}

/// 开始登录：在系统浏览器里打开官网。密码只在官网输入，工作台和 Host 都不经手。
async fn session_login(State(state): State<Arc<App>>) -> Json<Value> {
    match state.cloud.begin_login().await {
        Ok(url) => {
            let opened = open::that_detached(&url).is_ok();
            Json(json!({ "ok": true, "url": url, "opened": opened }))
        }
        Err(e) => Json(e.json()),
    }
}

#[derive(Deserialize)]
struct CodeBody {
    code: String,
}

async fn session_complete(
    State(state): State<Arc<App>>,
    Json(body): Json<CodeBody>,
) -> Json<Value> {
    match state.cloud.complete_login(body.code.trim()).await {
        Ok(()) => Json(state.cloud.view().await),
        Err(e) => Json(e.json()),
    }
}

/// 退出登录：没登录就不能用，所以正在跑的环境一起停掉。
async fn session_logout(State(state): State<Arc<App>>) -> Json<Value> {
    let running: Vec<String> = state.runtimes.lock().await.keys().cloned().collect();
    for env_id in running {
        let _ = stop_environment(&state.paths, &env_id, &state.runtimes, &state.bridges).await;
    }
    state.cloud.logout().await;
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct SiteBody {
    page: String,
}

/// 在系统浏览器里打开官网的账号页或套餐页。只有这两页：页面不能让 Host 去打开任意地址。
async fn session_site(State(state): State<Arc<App>>, Json(body): Json<SiteBody>) -> Json<Value> {
    let page = match body.page.as_str() {
        "account" => "account",
        "pricing" => "pricing",
        _ => return Json(json!({ "ok": false, "code": "BAD_PAGE", "message": "没有这一页。" })),
    };
    match state.cloud.site_url(page) {
        Ok(url) => Json(json!({ "ok": open::that_detached(&url).is_ok(), "url": url })),
        Err(e) => Json(e.json()),
    }
}

async fn profile_put(
    State(state): State<Arc<App>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    if !valid_env_id(&id) {
        return Json(json!({ "ok": false, "code": "BAD_ENV_ID", "message": "环境 id 不合法。" }));
    }
    Json(
        state
            .cloud
            .put_profile(&id, body)
            .await
            .unwrap_or_else(|e| e.json()),
    )
}

/* 文件夹：授权的单位。规则完全在服务器那边，本机只转发——
在这里复制一份"谁能改文件夹"的判断，就是第二份真相。 */

async fn folders_list(State(state): State<Arc<App>>) -> Json<Value> {
    Json(
        state
            .cloud
            .sync_get("/v1/folders")
            .await
            .unwrap_or_else(|e| e.json()),
    )
}

async fn folder_put(
    State(state): State<Arc<App>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    Json(
        state
            .cloud
            .sync_put(&format!("/v1/folders/{id}"), body)
            .await
            .unwrap_or_else(|e| e.json()),
    )
}

async fn folder_delete(State(state): State<Arc<App>>, Path(id): Path<String>) -> Json<Value> {
    Json(
        state
            .cloud
            .sync_delete(&format!("/v1/folders/{id}"))
            .await
            .unwrap_or_else(|e| e.json()),
    )
}

async fn profile_delete(State(state): State<Arc<App>>, Path(id): Path<String>) -> Json<Value> {
    if !valid_env_id(&id) {
        return Json(json!({ "ok": false, "code": "BAD_ENV_ID", "message": "环境 id 不合法。" }));
    }
    // 先停再删登记：服务器不让删正在跑的。
    stop_and_release(&state, &id).await;
    Json(
        state
            .cloud
            .delete_profile(&id)
            .await
            .unwrap_or_else(|e| e.json()),
    )
}

/// 停一个环境，并把它的运行名额还给服务器。所有"停"都走这里。
async fn stop_and_release(state: &App, env_id: &str) {
    // 盯新标签页的那条连接先收掉：连接一断，内核会自动放掉所有还等着的页面。
    if let Some(watcher) = state.supervisors.lock().await.remove(env_id) {
        watcher.abort();
    }
    // 先导登录态：浏览器一关就导不出来了。
    save_cookies(state, env_id).await;
    let _ = stop_environment(&state.paths, env_id, &state.runtimes, &state.bridges).await;
    state.cloud.release(env_id).await;
}

#[derive(Deserialize)]
struct FlagsBody {
    flags: Vec<String>,
}

/// 启动参数的判定规则只有 flags.rs 这一份：工作台的参数页来这里问，启动时用的也是它。
async fn flags_classify(Json(body): Json<FlagsBody>) -> Json<Value> {
    let verdicts: Vec<_> = body
        .flags
        .iter()
        .take(200)
        .map(|f| enclave_host::flags::classify(f))
        .collect();
    Json(json!({ "ok": true, "flags": verdicts }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBody {
    env_id: String,
    #[serde(flatten)]
    spec: StartSpec,
}

/* ── 批量执行 ────────────────────────────────────────────────────
选一批环境，一次做同一件事。排队的规矩由服务器定：额度满了就等一会儿再来，
这正是队列该有的行为；真正的错（内核对不上、代理连不上）不重试。 */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchBody {
    /// start / stop。start 时每个环境要带上自己的启动参数。
    action: String,
    items: Vec<BatchItem>,
    /// 同时开几个。上限仍然是服务器说的那个数，这里只是别一次把请求全撒出去。
    #[serde(default)]
    concurrency: usize,
    /// 遇到"等一下"最多再试几次。
    #[serde(default)]
    retries: u32,
    /// 启动之后打开这个网址。留空就只是启动。
    #[serde(default)]
    open_url: Option<String>,
    /// action 为 workflow 时：跑哪个流程（本机存储里的 id）。
    #[serde(default)]
    workflow_id: Option<String>,
    /// 流程跑完要不要把环境停掉。默认停：批量跑流程的人不想留一排窗口。
    #[serde(default = "yes")]
    stop_after: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchItem {
    env_id: String,
    #[serde(default)]
    spec: Option<StartSpec>,
}

async fn batch_run(State(state): State<Arc<App>>, Json(body): Json<BatchBody>) -> Json<Value> {
    if body.items.is_empty() || body.items.len() > 200 {
        return refuse("BAD_BATCH", "一次最少一个、最多 200 个环境。");
    }
    if body.action != "start" && body.action != "stop" && body.action != "workflow" {
        return refuse("BAD_BATCH", "只能批量启动、批量停止或运行流程。");
    }
    if body.action == "workflow" {
        let Some(id) = body.workflow_id.as_deref() else {
            return refuse("BAD_BATCH", "请选择要运行的流程。");
        };
        match state.store.get(enclave_host::store::Kind::Workflow, id) {
            Ok(Some(doc)) => {
                if serde_json::from_value::<enclave_host::workflow::Workflow>(doc).is_err() {
                    return refuse("BAD_BATCH", "该流程的内容无法识别，请在自动化页重新保存。");
                }
            }
            _ => return refuse("BAD_BATCH", "该流程不存在。"),
        }
    }
    if let Some(url) = &body.open_url {
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return refuse("BAD_BATCH", "要打开的网址得以 http:// 或 https:// 开头。");
        }
    }
    let run_id = enclave_host::sync::new_key_id();
    let env_ids: Vec<String> = body.items.iter().map(|i| i.env_id.clone()).collect();
    state.batch.start(
        &run_id,
        &body.action,
        &env_ids,
        enclave_host::kernel::now_ms(),
    );

    let app = state.clone();
    let id = run_id.clone();
    tokio::spawn(async move { run_batch(app, id, body).await });
    Json(json!({ "ok": true, "runId": run_id, "count": env_ids.len() }))
}

/// 一批的执行。同时最多 `concurrency` 个在手上，做完一个补一个。
async fn run_batch(state: Arc<App>, run_id: String, body: BatchBody) {
    use enclave_host::batch::{worth_retrying, State as ItemState};
    let limit = body.concurrency.clamp(1, 8);
    let retries = body.retries.min(10);
    let mut queue = body
        .items
        .into_iter()
        .collect::<std::collections::VecDeque<_>>();
    let mut running = tokio::task::JoinSet::new();

    loop {
        while running.len() < limit {
            if state.batch.cancelled(&run_id) {
                break;
            }
            let Some(item) = queue.pop_front() else { break };
            let app = state.clone();
            let id = run_id.clone();
            let action = body.action.clone();
            let open = body.open_url.clone();
            let workflow_id = body.workflow_id.clone();
            let stop_after = body.stop_after;
            app.batch
                .update(&id, &item.env_id, |i| i.state = ItemState::Running);
            running.spawn(async move {
                let mut tries = 0u32;
                let proxy = item.spec.as_ref().and_then(|s| s.proxy_id.clone());
                // 补登记只做一次：登记了还说没登记，那是别的问题，重试解决不了。
                let mut registered = false;
                loop {
                    // 同一个出口 IP 上同时冒出一堆登录，风控立刻就来。排到轮次再走。
                    if action != "stop" {
                        while let Err(wait) = app.gate.admit(proxy.as_deref(), enclave_host::kernel::now_ms()) {
                            if app.batch.cancelled(&id) {
                                app.batch.update(&id, &item.env_id, |i| i.state = ItemState::Skipped);
                                return;
                            }
                            // 界面上不写原因的话，这一条会干等三十秒、看着像卡死。
                            app.batch.update(&id, &item.env_id, |i| {
                                i.message = format!("同一代理要隔开启动，还要等 {wait} 秒");
                            });
                            tokio::time::sleep(std::time::Duration::from_secs(wait.min(30))).await;
                        }
                        app.batch.update(&id, &item.env_id, |i| i.message.clear());
                    }
                    let out = if action == "stop" {
                        stop_and_release(&app, &item.env_id).await;
                        json!({ "ok": true })
                    } else {
                        match &item.spec {
                            Some(spec) => run_start(&app, &item.env_id, spec).await.0,
                            None => json!({ "ok": false, "code": "BAD_BATCH", "message": "少了启动参数。" }),
                        }
                    };
                    if action != "stop" {
                        app.gate.release(proxy.as_deref());
                    }
                    let mut out = out;
                    let mut code = out["code"].as_str().unwrap_or("").to_string();
                    // 还没在账号下登记过（旧版本建的、或者导入进来的）：登记了再来一次。
                    // 单个启动本来就是这么做的，批量不能是另一套行为。
                    // 启动和跑流程走同一条路：没登记过就补登记，不能只有"启动"享受这一条。
                    if code == "PROFILE_UNKNOWN" && action != "stop" && !registered {
                        registered = true;
                        if register_env(&app, &item.env_id).await {
                            out = match &item.spec {
                                Some(spec) => run_start(&app, &item.env_id, spec).await.0,
                                None => out,
                            };
                            code = out["code"].as_str().unwrap_or("").to_string();
                        }
                    }
                    // 启动成功、这一批是跑流程：现在跑。流程失败算这一项失败，环境按选项停掉。
                    if out["ok"] == true && action == "workflow" {
                        let engine = app.runtimes.lock().await.get(&item.env_id).map(|r| r.engine);
                        let wf = workflow_id
                            .as_deref()
                            .and_then(|id| app.store.get(enclave_host::store::Kind::Workflow, id).ok().flatten())
                            .and_then(|doc| serde_json::from_value::<enclave_host::workflow::Workflow>(doc).ok());
                        let outcome = match (engine, wf, out["port"].as_u64()) {
                            (Some(engine), Some(wf), Some(port)) => {
                                let app2 = app.clone();
                                let id2 = id.clone();
                                enclave_host::workflow::run(engine, port as u16, &wf, move || {
                                    app2.batch.cancelled_sync(&id2)
                                })
                                .await
                            }
                            _ => enclave_host::workflow::Outcome {
                                ok: false,
                                failed_at: Some(1),
                                vars: Default::default(),
                                log: vec![enclave_host::workflow::StepLog { index: 1, ok: false, message: "环境起来了，但流程读不出来".into() }],
                            },
                        };
                        if stop_after {
                            stop_and_release(&app, &item.env_id).await;
                        }
                        let last = outcome.log.last().map(|l| l.message.clone()).unwrap_or_default();
                        app.batch.update(&id, &item.env_id, |i| {
                            i.tries = tries;
                            if outcome.ok {
                                i.state = ItemState::Done;
                                i.message = format!("流程跑完，{} 步", outcome.log.len());
                            } else {
                                i.state = ItemState::Failed;
                                i.code = "WORKFLOW_FAILED".into();
                                i.message = match outcome.failed_at {
                                    Some(n) => format!("第 {n} 步失败：{last}"),
                                    None => last,
                                };
                            }
                        });
                        return;
                    }
                    if out["ok"] == true {
                        // 启动成功、又指定了网址：打开它。打不开不算这一批失败——环境已经起来了。
                        if let (Some(url), Some(port)) = (open.as_deref(), out["port"].as_u64()) {
                            let engine = app
                                .runtimes
                                .lock()
                                .await
                                .get(&item.env_id)
                                .map(|r| r.engine);
                            if let Some(engine) = engine {
                                let _ = enclave_host::cookies::open_url(engine, port as u16, url).await;
                            }
                        }
                        app.batch.update(&id, &item.env_id, |i| {
                            i.state = ItemState::Done;
                            i.tries = tries;
                        });
                        return;
                    }
                    if tries < retries && worth_retrying(&code) && !app.batch.cancelled(&id) {
                        tries += 1;
                        app.batch.update(&id, &item.env_id, |i| i.tries = tries);
                        // 等一会儿：额度是别的电脑在占，或者对方还没停。
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        continue;
                    }
                    app.batch.update(&id, &item.env_id, |i| {
                        i.state = ItemState::Failed;
                        i.code = code.clone();
                        i.message = out["message"].as_str().unwrap_or("").to_string();
                        i.tries = tries;
                    });
                    return;
                }
            });
        }
        if running.is_empty() {
            break;
        }
        let _ = running.join_next().await;
    }
    state.batch.finish(&run_id, enclave_host::kernel::now_ms());
}

/// 把这个环境在账号下登记一次。名字、分组、内核版本都在本机存储里，页面不用参与。
async fn register_env(state: &App, env_id: &str) -> bool {
    let Ok(Some(doc)) = state
        .store
        .get(enclave_host::store::Kind::Environment, env_id)
    else {
        return false;
    };
    let body = json!({
        "name": doc.get("name").and_then(Value::as_str).unwrap_or(env_id),
        "folderId": doc.get("folderId").and_then(Value::as_str).unwrap_or("default"),
        "engineVersion": doc.get("kernelVersion").and_then(Value::as_str).unwrap_or(""),
        "os": doc.pointer("/profile/platform").and_then(Value::as_str).unwrap_or("windows"),
    });
    matches!(state.cloud.put_profile(env_id, body).await, Ok(v) if v["ok"] == true)
}

async fn batch_runs(State(state): State<Arc<App>>) -> Json<Value> {
    let runs: Vec<Value> = state
        .batch
        .list()
        .into_iter()
        .map(|r| {
            let (done, failed, total) = r.counts();
            json!({
                "id": r.id, "action": r.action, "startedAt": r.started_at,
                "finishedAt": r.finished_at, "cancelled": r.cancelled,
                "done": done, "failed": failed, "total": total,
                "items": r.items,
            })
        })
        .collect();
    Json(json!({ "ok": true, "runs": runs }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelBody {
    run_id: String,
}

async fn batch_cancel(State(state): State<Arc<App>>, Json(body): Json<CancelBody>) -> Json<Value> {
    if state.batch.cancel(&body.run_id) {
        Json(json!({ "ok": true }))
    } else {
        refuse("BATCH_DONE", "这一批已经跑完了。")
    }
}

async fn env_start(State(state): State<Arc<App>>, Json(body): Json<StartBody>) -> Json<Value> {
    run_start(&state, &body.env_id, &body.spec).await
}

/// 启动一个环境。工作台点启动和脚本调 API 走的是同一段代码。
async fn run_start(state: &Arc<App>, env_id: &str, spec: &StartSpec) -> Json<Value> {
    if !valid_env_id(env_id) {
        return Json(json!({ "ok": false, "code": "BAD_ENV_ID", "message": "环境 id 不合法。" }));
    }
    let Some(slot) = state.slot(&spec.kernel_version).await else {
        return unknown_kernel(&spec.kernel_version);
    };
    if slot.record.channel != "stable" && !spec.allow_preview_channel {
        return Json(json!({
            "ok": false,
            "code": "KERNEL_CHANNEL_BLOCKED",
            "message": "这个内核还是预览通道，需要在安全中心明确同意后才能启动。",
        }));
    }
    // 服务器说了算：同时运行数按账号下所有电脑合计，同一个环境同一时刻只在一台电脑上开着。
    // 没登录、连不上服务器，都到不了下面。
    if let Err(e) = state.cloud.acquire(env_id).await {
        return Json(e.json());
    }
    // 代理地址和密码从 Host 自己的存储里取：页面只说"用哪个代理"，不经手密码。
    let proxy_url = match spec.proxy_id.as_deref() {
        Some(id) => {
            let vault = state.vault.lock().await;
            match state.store.proxy_url(vault.key(), id) {
                Ok(url) => Some(url),
                Err((code, message)) => {
                    drop(vault);
                    state.cloud.release(env_id).await;
                    return Json(json!({ "ok": false, "code": code, "message": message }));
                }
            }
        }
        None => None,
    };
    let full_verify = !slot.verified_once.load(Ordering::Relaxed);
    match start_environment(
        &state.paths,
        &slot.record,
        env_id,
        spec,
        &state.runtimes,
        &state.bridges,
        Launch {
            full_verify,
            proxy_url: proxy_url.as_deref(),
        },
    )
    .await
    {
        Ok(s) => {
            slot.verified_once.store(true, Ordering::Relaxed);
            // 定位跟着代理出口走。时区和语言已经跟了，唯独定位不跟的话，
            // 代理在柏林、时区是柏林、语言是德语，一问定位却在别处——一查就露。
            // 走内核的 Emulation 域，不是往页面注 JS：注 JS 会被查出来，这条不会。
            // 用户可以选：跟着出口、自己填、用真实位置、或者整个禁用。
            // Firefox 类的这几条都在启动配置里做完了，这里只管 Chromium 类。
            if slot.record.engine == Engine::Chromium {
                let geo = &spec.profile.geolocation;
                if geo.blocked() {
                    if let Err(why) = enclave_host::cdp::block_geolocation(s.port).await {
                        eprintln!("环境 {env_id} 的定位没禁掉：{why:#}");
                    }
                } else if let Some((lat, lon)) = geo.resolve(s.exit.as_ref().and_then(|e| e.coords))
                {
                    if let Err(why) = enclave_host::cdp::set_geolocation(s.port, lat, lon).await {
                        eprintln!("环境 {env_id} 的定位没设上：{why:#}");
                    }
                    // 上面那一刀只管启动时的标签页。用户新开的标签页要在它跑第一行 JS
                    // 之前就设好，所以留一条连接盯着。
                    let watcher = enclave_host::cdp::supervise_new_tabs(
                        s.port,
                        enclave_host::cdp::GeoRule::At(lat, lon),
                    );
                    if let Some(old) = state
                        .supervisors
                        .lock()
                        .await
                        .insert(env_id.to_string(), watcher)
                    {
                        old.abort();
                    }
                }
            }
            // 云端有更新的登录态就放进去，然后才把浏览器交给用户。
            let restored = restore_cookies(state, env_id, slot.record.engine, s.port).await;
            Json(json!({
                "ok": true,
                "pid": s.pid,
                "port": s.port,
                "exit": s.exit,
                "timezone": s.timezone,
                "locale": s.locale,
                "languages": s.languages,
                "debugAddress": "127.0.0.1",
                "sha256": s.sha256,
                "warned": s.warned,
                "userDataDir": s.user_data_dir,
                "cookiesRestored": restored,
            }))
        }
        Err((code, message)) => {
            // 没起来就不占名额。环境本来就在跑（重复点启动）的话，租约还是它的，不能还。
            if !state.runtimes.lock().await.contains_key(env_id) {
                state.cloud.release(env_id).await;
            }
            Json(json!({ "ok": false, "code": code, "message": message }))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopBody {
    env_id: String,
}

async fn search_engines(
    State(state): State<Arc<App>>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let env_id = q.get("envId").cloned().unwrap_or_default();
    let engines = list_search_engines(&state.paths, &env_id);
    Json(json!({ "ok": true, "engines": engines }))
}

async fn env_stop(State(state): State<Arc<App>>, Json(body): Json<StopBody>) -> Json<Value> {
    stop_and_release(&state, &body.env_id).await;
    Json(json!({ "ok": true }))
}

/// 彻底删除：先停，再删掉磁盘上的用户数据。界面上的「彻底删除」必须真的删。
async fn env_purge(State(state): State<Arc<App>>, Json(body): Json<StopBody>) -> Json<Value> {
    stop_and_release(&state, &body.env_id).await;
    match purge_environment(&state.paths, &body.env_id).await {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "code": "PURGE_FAILED", "message": e.to_string() })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectBody {
    env_id: String,
}

async fn lab_collect(State(state): State<Arc<App>>, Json(body): Json<CollectBody>) -> Json<Value> {
    let rt = state.runtimes.lock().await.get(&body.env_id).cloned();
    let Some(rt) = rt else {
        return Json(
            json!({ "ok": false, "code": "NOT_RUNNING", "message": "environment is not running" }),
        );
    };
    // 采集脚本是同一段，送进去的协议按内核的类选。
    let collected = match rt.engine {
        Engine::Chromium => enclave_host::cdp::collect(rt.port).await,
        Engine::Firefox => enclave_host::bidi::collect(rt.port).await,
    };
    match collected {
        Ok(snap) => Json(json!({ "ok": true, "snapshot": snap })),
        Err(e) => {
            Json(json!({ "ok": false, "code": "CDP_HANDSHAKE_FAILED", "message": e.to_string() }))
        }
    }
}

/* ── 给脚本用的本机 API ───────────────────────────────────────────── */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiConfigBody {
    enabled: bool,
    #[serde(default)]
    environments: Vec<EnvEntry>,
}

/// 工作台推配置：开关和环境清单。第一次开启时生成令牌。档位不在这里：Host 自己问服务器。
async fn api_config(State(state): State<Arc<App>>, Json(body): Json<ApiConfigBody>) -> Json<Value> {
    let mut api = state.api.lock().await;
    api.enabled = body.enabled;
    api.envs = body
        .environments
        .into_iter()
        .map(|e| (e.id.clone(), e))
        .collect();
    if api.enabled && api.token.is_empty() {
        api.token = new_token();
        write_private(&api_token_path(&state.paths), &api.token);
    }
    Json(json!({
        "ok": true,
        "enabled": api.enabled,
        "token": if api.enabled { api.token.clone() } else { String::new() },
    }))
}

/// 重置令牌：旧令牌立刻失效。
async fn api_rotate(State(state): State<Arc<App>>) -> Json<Value> {
    let mut api = state.api.lock().await;
    api.token = new_token();
    write_private(&api_token_path(&state.paths), &api.token);
    Json(json!({ "ok": true, "token": api.token }))
}

fn api_env_view(entry: &EnvEntry, rt: Option<&RuntimeRow>) -> Value {
    json!({
        "id": entry.id,
        "name": entry.name,
        "folderId": entry.folder_id,
        "status": if rt.is_some() { "running" } else { "stopped" },
        "pid": rt.map(|r| r.pid),
        "debugPort": rt.map(|r| r.port),
        "debugAddress": rt.map(|_| "127.0.0.1"),
    })
}

async fn api_list(State(state): State<Arc<App>>) -> Json<Value> {
    prune_dead(&state.paths, &state.runtimes).await;
    let api = state.api.lock().await;
    let runtimes = state.runtimes.lock().await;
    let mut envs: Vec<Value> = api
        .envs
        .values()
        .map(|e| api_env_view(e, runtimes.get(&e.id)))
        .collect();
    envs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Json(json!({ "ok": true, "environments": envs }))
}

async fn api_get(State(state): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let api = state.api.lock().await;
    let runtimes = state.runtimes.lock().await;
    match api.envs.get(&id) {
        Some(e) => Json(json!({ "ok": true, "environment": api_env_view(e, runtimes.get(&id)) }))
            .into_response(),
        None => not_found(),
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "ok": false, "code": "NOT_FOUND", "message": "没有这个环境。" })),
    )
        .into_response()
}

async fn api_start(State(state): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let spec = match state.api.lock().await.envs.get(&id) {
        Some(e) => e.spec.clone(),
        None => return not_found(),
    };
    // 同时运行上限由服务器在 run_start 里数，脚本和工作台走的是同一道闸。
    let Json(started) = run_start(&state, &id, &spec).await;
    if started["ok"] != true {
        return Json(started).into_response();
    }
    // 成功时回 API 自己的格式（和列表、详情同一个对象），不把工作台内部的启动结果漏给脚本。
    let api = state.api.lock().await;
    let runtimes = state.runtimes.lock().await;
    match api.envs.get(&id) {
        Some(e) => Json(json!({ "ok": true, "environment": api_env_view(e, runtimes.get(&id)) }))
            .into_response(),
        None => not_found(),
    }
}

async fn api_stop(State(state): State<Arc<App>>, Path(id): Path<String>) -> Response {
    // 工作台后来把某个环境从推送列表里拿掉了（比如移进了回收站）；但脚本启动过的环境必须还能停。
    let known = state.api.lock().await.envs.contains_key(&id)
        || state.runtimes.lock().await.contains_key(&id);
    if !known {
        return not_found();
    }
    stop_and_release(&state, &id).await;
    Json(json!({ "ok": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_long_and_random() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64, "32 字节十六进制");
        assert_ne!(a, b, "两次生成不能相同");
    }

    #[test]
    fn token_compare_rejects_prefix_and_length_tricks() {
        let real = "a".repeat(64);
        assert!(token_matches(&real, &real));
        assert!(!token_matches("a", &real));
        assert!(!token_matches(&"a".repeat(63), &real));
        assert!(!token_matches(&format!("{}b", "a".repeat(63)), &real));
        assert!(!token_matches("", &real));
    }

    /// 操作员能碰什么、不能碰什么，就这一张表说了算。
    /// 漏掉一条就等于员工能把整个团队的店铺资产带走，所以正反两面都盯住。
    #[test]
    fn operators_cannot_change_or_take_out_team_data() {
        for (m, p) in [
            (Method::POST, "/v1/secrets/export"),
            (Method::POST, "/v1/secrets/import"),
            (Method::PUT, "/v1/secrets/proxy:prx_1"),
            (Method::DELETE, "/v1/secrets/proxy:prx_1"),
            (Method::PUT, "/v1/store/environments/env_1"),
            (Method::DELETE, "/v1/store/environments/env_1"),
            (Method::PUT, "/v1/store/proxies/prx_1"),
            (Method::DELETE, "/v1/store/proxies/prx_1"),
            (Method::PUT, "/v1/profiles/env_1"),
            (Method::DELETE, "/v1/profiles/env_1"),
            (Method::POST, "/v1/sync/enable"),
            (Method::POST, "/v1/sync/disable"),
            (Method::POST, "/v1/sync/approve"),
        ] {
            assert!(operator_blocked(&m, p), "{m} {p} 该拦没拦住");
        }
        // 他要干活：打开环境、跑同步、解锁应用锁、看东西，都得放行。
        for (m, p) in [
            (Method::POST, "/v1/environments/start"),
            (Method::POST, "/v1/environments/stop"),
            (Method::GET, "/v1/store"),
            (Method::GET, "/v1/sync"),
            (Method::POST, "/v1/sync/run"),
            (Method::GET, "/v1/sync/usage"),
            (Method::POST, "/v1/sync/adopt"),
            (Method::POST, "/v1/vault/unlock"),
            (Method::POST, "/v1/kernel/admit"),
            (Method::GET, "/v1/session"),
        ] {
            assert!(!operator_blocked(&m, p), "{m} {p} 不该拦");
        }
    }

    #[test]
    fn app_origins_are_all_loopback_or_tauri() {
        for o in APP_ORIGINS {
            assert!(
                o.starts_with("tauri://")
                    || o.contains("tauri.localhost")
                    || o.contains("127.0.0.1")
                    || o.contains("localhost"),
                "{o} 不该出现在本机来源名单里"
            );
            assert!(HeaderValue::from_str(o).is_ok());
        }
    }
}
