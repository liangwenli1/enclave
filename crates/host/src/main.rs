use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use enclave_host::kernel::{
    admit, capabilities, ensure_dirs, load_manifest, read_status_fast, restore_runtimes,
    start_environment, stop_environment, stable_linux, FingerprintProfile, HostPaths, KernelRecord,
    KernelStatus, ManifestFile, RuntimeRow,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

struct App {
    paths: HostPaths,
    kernel: KernelRecord,
    manifest: ManifestFile,
    token: String,
    status: Arc<Mutex<KernelStatus>>,
    runtimes: Arc<Mutex<HashMap<String, RuntimeRow>>>,
    admitting: Arc<Mutex<bool>>,
}

#[tokio::main]
async fn main() {
    let cwd = std::env::current_dir().expect("cwd");
    let paths = HostPaths::new(&cwd);
    ensure_dirs(&paths).await.expect("data dirs");
    let token = load_or_create_token(&paths.token);
    let manifest = load_manifest(&paths.manifest).expect("kernels.manifest.json");
    let kernel = stable_linux(&manifest).expect("stable kernel").clone();
    let status = read_status_fast(&paths, &kernel).await;
    let runtimes = Arc::new(Mutex::new(HashMap::new()));
    restore_runtimes(&paths, &runtimes).await;
    let state = Arc::new(App {
        paths,
        kernel,
        manifest,
        token,
        status: Arc::new(Mutex::new(status)),
        runtimes,
        admitting: Arc::new(Mutex::new(false)),
    });

    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/kernel", get(kernel_view))
        .route("/v1/kernel/admit", post(kernel_admit))
        .route("/v1/runtimes", get(list_runtimes))
        .route("/v1/environments/start", post(env_start))
        .route("/v1/environments/stop", post(env_stop))
        .route("/v1/lab/collect", post(lab_collect))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(state);

    let bind = std::env::var("ENCLAVE_HOST_BIND").unwrap_or_else(|_| "127.0.0.1:17891".into());
    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    eprintln!("enclave-host listening on {bind}");
    axum::serve(listener, app).await.expect("serve");
}

fn load_or_create_token(path: &PathBuf) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let t = existing.trim();
        if t.len() >= 16 {
            return t.to_string();
        }
    }
    let token = format!("{:x}{:x}", now_rand(), now_rand());
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let _ = std::fs::write(path, &token);
    token
}

fn now_rand() -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::process::id().hash(&mut h);
    h.finish()
}

async fn auth(State(state): State<Arc<App>>, req: Request, next: Next) -> Response {
    if req.uri().path() == "/v1/health" {
        return next.run(req).await;
    }
    let header = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    if header != format!("Bearer {}", state.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "code": "UNAUTHORIZED"}))).into_response();
    }
    next.run(req).await
}

async fn health(State(state): State<Arc<App>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "host": "rust",
        "version": env!("CARGO_PKG_VERSION"),
        "kernelId": state.kernel.id,
        "kernelVersion": state.kernel.version,
        "capabilities": capabilities(),
    }))
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
            "previousStable": state.manifest.previous_stable,
            "channel": state.manifest.channel,
        },
        "capabilities": capabilities(),
        "runtimes": runtimes,
        "host": "rust",
    }))
}

async fn kernel_admit(State(state): State<Arc<App>>) -> Json<Value> {
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
    tokio::spawn(async move {
        if let Err(e) = admit(&paths, &kernel, &status).await {
            let mut s = status.lock().await;
            if s.state != "hash_mismatch" {
                s.state = "error".into();
                s.error = Some(e.to_string());
            }
        }
        *admitting.lock().await = false;
    });
    Json(json!(state.status.lock().await.clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBody {
    env_id: String,
    profile: FingerprintProfile,
    #[serde(default)]
    extra_flags: Vec<String>,
    #[serde(default)]
    allow_no_sandbox: bool,
    proxy_server: Option<String>,
    search_engine: Option<String>,
}

async fn env_start(State(state): State<Arc<App>>, Json(body): Json<StartBody>) -> Json<Value> {
    match start_environment(
        &state.paths,
        &state.kernel,
        &body.env_id,
        &body.profile,
        &body.extra_flags,
        body.allow_no_sandbox,
        body.proxy_server.as_deref(),
        body.search_engine.as_deref(),
        &state.runtimes,
    )
    .await
    {
        Ok(s) => Json(json!({
            "ok": true,
            "pid": s.pid,
            "port": s.port,
            "debugAddress": "127.0.0.1",
            "sha256": s.sha256,
            "warned": s.warned,
            "userDataDir": s.user_data_dir,
            "host": "rust",
            "runtime": "native",
        })),
        Err((code, message)) => Json(json!({ "ok": false, "code": code, "message": message, "host": "rust" })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopBody {
    env_id: String,
}

async fn env_stop(State(state): State<Arc<App>>, Json(body): Json<StopBody>) -> Json<Value> {
    let _ = stop_environment(&state.paths, &body.env_id, &state.runtimes).await;
    Json(json!({ "ok": true }))
}

async fn list_runtimes(State(state): State<Arc<App>>) -> Json<Value> {
    restore_runtimes(&state.paths, &state.runtimes).await;
    Json(json!(state.runtimes.lock().await.values().cloned().collect::<Vec<_>>()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectBody {
    env_id: String,
}

async fn lab_collect(State(state): State<Arc<App>>, Json(body): Json<CollectBody>) -> Json<Value> {
    let rt = state.runtimes.lock().await.get(&body.env_id).cloned();
    let Some(rt) = rt else {
        return Json(json!({ "ok": false, "code": "NOT_RUNNING", "message": "environment is not running" }));
    };
    match enclave_host::cdp::collect(rt.port).await {
        Ok(snap) => Json(json!({ "ok": true, "snapshot": snap })),
        Err(e) => Json(json!({ "ok": false, "code": "CDP_HANDSHAKE_FAILED", "message": e.to_string() })),
    }
}
