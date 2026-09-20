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
use axum::routing::{get, post};
use axum::{Json, Router};
use enclave_host::api::{allows, ApiLevel, EnvEntry, StartSpec};
use enclave_host::kernel::{
    admit, capabilities, ensure_dirs, kernel_for_this_os, list_search_engines, load_manifest,
    read_status_fast, restore_runtimes, start_environment, stop_environment, HostPaths,
    KernelRecord, KernelStatus, ManifestFile, RuntimeRow,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
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
    kernel: KernelRecord,
    manifest: ManifestFile,
    token: String,
    status: Arc<Mutex<KernelStatus>>,
    runtimes: Arc<Mutex<HashMap<String, RuntimeRow>>>,
    admitting: Arc<Mutex<bool>>,
    /// 本进程是否已经完整校验过内核可执行文件。第一次启动环境时做全量 sha256，
    /// 之后只比对大小与修改时间，免得每次启动都读一遍上百 MB。
    verified_once: Arc<AtomicBool>,
    api: Arc<Mutex<ApiState>>,
}

/// 给脚本用的 API 的运行时状态。开关、档位、环境清单都由工作台推过来，只在内存里；
/// 只有令牌落盘（0600），这样重启后脚本那边配置的令牌还能用。
#[derive(Default)]
struct ApiState {
    enabled: bool,
    level: ApiLevel,
    concurrent: usize,
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
    let kernel = kernel_for_this_os(&manifest)
        .expect("本平台没有可用内核清单")
        .clone();
    let status = read_status_fast(&paths, &kernel).await;
    let runtimes = Arc::new(Mutex::new(HashMap::new()));
    restore_runtimes(&paths, &runtimes).await;
    let api = ApiState {
        token: std::fs::read_to_string(api_token_path(&paths))
            .map(|t| t.trim().to_string())
            .unwrap_or_default(),
        ..ApiState::default()
    };
    let state = Arc::new(App {
        paths,
        kernel,
        manifest,
        token,
        status: Arc::new(Mutex::new(status)),
        runtimes,
        admitting: Arc::new(Mutex::new(false)),
        verified_once: Arc::new(AtomicBool::new(false)),
        api: Arc::new(Mutex::new(api)),
    });

    let origins: Vec<HeaderValue> = APP_ORIGINS
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();

    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/kernel", get(kernel_view))
        .route("/v1/kernel/admit", post(kernel_admit))
        .route("/v1/runtimes", get(list_runtimes))
        .route("/v1/environments/start", post(env_start))
        .route("/v1/environments/stop", post(env_stop))
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
                .allow_methods([Method::GET, Method::POST])
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

async fn guard(State(state): State<Arc<App>>, req: Request, next: Next) -> Response {
    // 1. Host 头必须是回环。浏览器把某个域名解析到 127.0.0.1 时，Host 头会是那个域名。
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| {
            let name = h.split(':').next().unwrap_or("");
            name == "127.0.0.1" || name == "localhost" || name == "[::1]"
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
        if !allows(api.level, req.method().as_str(), req.uri().path()) {
            return deny("API_SCOPE", "当前档位的本机 API 是只读的，不能启动或停止环境。");
        }
        drop(api);
        return next.run(req).await;
    }

    // 2. 有 Origin 就必须在名单里。网页发来的请求一定带 Origin。
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
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
    let status = read_status_fast(&state.paths, &state.kernel).await;
    *state.status.lock().await = status.clone();
    let runtimes: Vec<RuntimeRow> = state.runtimes.lock().await.values().cloned().collect();
    Json(json!({
        "status": status,
        "kernel": {
            "manifest": state.kernel,
            "kernels": state.manifest.kernels,
            "channel": state.manifest.channel,
        },
        "capabilities": capabilities(),
        "runtimes": runtimes,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AdmitBody {
    /// 内核不是 stable 通道时，必须由用户在安全中心明确同意。
    #[serde(default)]
    allow_preview_channel: bool,
}

async fn kernel_admit(
    State(state): State<Arc<App>>,
    body: Option<Json<AdmitBody>>,
) -> Json<Value> {
    let allow_preview = body.map(|b| b.allow_preview_channel).unwrap_or(false);
    if state.kernel.channel != "stable" && !allow_preview {
        return Json(json!({
            "ok": false,
            "code": "KERNEL_CHANNEL_BLOCKED",
            "message": "这个平台的内核还是预览通道，需要在安全中心明确同意后才能准入。",
        }));
    }
    {
        let mut flag = state.admitting.lock().await;
        if *flag {
            return Json(json!(state.status.lock().await.clone()));
        }
        *flag = true;
    }
    let paths = state.paths.clone();
    let kernel = state.kernel.clone();
    let status = state.status.clone();
    let admitting = state.admitting.clone();
    let verified = state.verified_once.clone();
    tokio::spawn(async move {
        if let Err(e) = admit(&paths, &kernel, &status).await {
            let mut s = status.lock().await;
            if s.state != "hash_mismatch" {
                s.state = "error".into();
                s.error = Some(e.to_string());
            }
        } else {
            // 准入过程本身刚做过全量校验，本进程内不必立刻再做一次。
            verified.store(true, Ordering::Relaxed);
        }
        *admitting.lock().await = false;
    });
    Json(json!(state.status.lock().await.clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBody {
    env_id: String,
    #[serde(flatten)]
    spec: StartSpec,
}

async fn env_start(State(state): State<Arc<App>>, Json(body): Json<StartBody>) -> Json<Value> {
    run_start(&state, &body.env_id, &body.spec).await
}

/// 启动一个环境。工作台点启动和脚本调 API 走的是同一段代码。
async fn run_start(state: &Arc<App>, env_id: &str, spec: &StartSpec) -> Json<Value> {
    if state.kernel.channel != "stable" && !spec.allow_preview_channel {
        return Json(json!({
            "ok": false,
            "code": "KERNEL_CHANNEL_BLOCKED",
            "message": "这个平台的内核还是预览通道，需要在安全中心明确同意后才能启动。",
        }));
    }
    let full_verify = !state.verified_once.load(Ordering::Relaxed);
    match start_environment(
        &state.paths,
        &state.kernel,
        env_id,
        &spec.profile,
        &spec.extra_flags,
        spec.allow_no_sandbox,
        spec.proxy_server.as_deref(),
        spec.search_engine.as_deref(),
        spec.search_provider.as_ref(),
        &state.runtimes,
        full_verify,
    )
    .await
    {
        Ok(s) => {
            state.verified_once.store(true, Ordering::Relaxed);
            Json(json!({
                "ok": true,
                "pid": s.pid,
                "port": s.port,
                "debugAddress": "127.0.0.1",
                "sha256": s.sha256,
                "warned": s.warned,
                "userDataDir": s.user_data_dir,
            }))
        }
        Err((code, message)) => {
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
    let _ = stop_environment(&state.paths, &body.env_id, &state.runtimes).await;
    Json(json!({ "ok": true }))
}

async fn list_runtimes(State(state): State<Arc<App>>) -> Json<Value> {
    restore_runtimes(&state.paths, &state.runtimes).await;
    Json(json!(state
        .runtimes
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>()))
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
    match enclave_host::cdp::collect(rt.port).await {
        Ok(snap) => Json(json!({ "ok": true, "snapshot": snap })),
        Err(e) => Json(
            json!({ "ok": false, "code": "CDP_HANDSHAKE_FAILED", "message": e.to_string() }),
        ),
    }
}

/* ── 给脚本用的本机 API ───────────────────────────────────────────── */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiConfigBody {
    enabled: bool,
    #[serde(default)]
    level: ApiLevel,
    #[serde(default)]
    concurrent: usize,
    #[serde(default)]
    environments: Vec<EnvEntry>,
}

/// 工作台推配置：开关、档位、同时运行上限、环境清单。第一次开启时生成令牌。
async fn api_config(State(state): State<Arc<App>>, Json(body): Json<ApiConfigBody>) -> Json<Value> {
    let mut api = state.api.lock().await;
    api.enabled = body.enabled && body.level != ApiLevel::Off;
    api.level = body.level;
    api.concurrent = body.concurrent;
    api.envs = body.environments.into_iter().map(|e| (e.id.clone(), e)).collect();
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
        "group": entry.group,
        "status": if rt.is_some() { "running" } else { "stopped" },
        "pid": rt.map(|r| r.pid),
        "debugPort": rt.map(|r| r.port),
        "debugAddress": rt.map(|_| "127.0.0.1"),
    })
}

async fn api_list(State(state): State<Arc<App>>) -> Json<Value> {
    restore_runtimes(&state.paths, &state.runtimes).await;
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
    let (spec, concurrent) = {
        let api = state.api.lock().await;
        match api.envs.get(&id) {
            Some(e) => (e.spec.clone(), api.concurrent),
            None => return not_found(),
        }
    };
    // 档位的同时运行上限对 API 同样生效，脚本不能绕过它。
    {
        let runtimes = state.runtimes.lock().await;
        if !runtimes.contains_key(&id) && concurrent > 0 && runtimes.len() >= concurrent {
            return Json(json!({
                "ok": false,
                "code": "PLAN_CONCURRENT_LIMIT",
                "message": format!("当前档位最多同时运行 {concurrent} 个环境。"),
            }))
            .into_response();
        }
    }
    run_start(&state, &id, &spec).await.into_response()
}

async fn api_stop(State(state): State<Arc<App>>, Path(id): Path<String>) -> Response {
    if !state.api.lock().await.envs.contains_key(&id) {
        return not_found();
    }
    let _ = stop_environment(&state.paths, &id, &state.runtimes).await;
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
