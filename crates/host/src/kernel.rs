use crate::flags::{classify, FlagClass};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::{sleep, Duration};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelRecord {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub channel: String,
    pub url: String,
    pub filename: String,
    pub sha256: String,
    pub bytes: u64,
    pub signature: String,
    pub publisher: String,
    pub released_at: String,
    pub upstream: String,
    pub license: String,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub channel: String,
    pub kernels: Vec<KernelRecord>,
    pub previous_stable: Option<KernelRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStatus {
    pub state: String,
    pub bytes_received: u64,
    pub bytes_expected: u64,
    pub sha256_expected: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256_actual: Option<String>,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admitted_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRow {
    pub env_id: String,
    pub pid: u32,
    pub port: u16,
    pub debug_address: String,
    pub started_at: u64,
    pub sha256: String,
    pub user_data_dir: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintProfile {
    pub seed: String,
    pub platform: String,
    pub platform_version: String,
    pub brand: String,
    pub brand_version: String,
    pub hardware_concurrency: u32,
    pub locale: String,
    pub languages: Vec<String>,
    pub timezone: String,
    pub screen: Screen,
    pub webrtc: Webrtc,
    #[serde(default)]
    pub disable_spoofing: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Webrtc {
    pub mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub host: String,
    pub os: String,
    pub arch: String,
    pub uid: Option<u32>,
    pub display: bool,
    pub loopback_only: bool,
    pub headless_forced: bool,
    pub sandbox_likely: bool,
    pub runtime: String,
}

pub fn capabilities() -> Capabilities {
    let uid = current_uid();
    Capabilities {
        host: "rust".into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        uid,
        display: !force_headless(),
        loopback_only: true,
        headless_forced: force_headless(),
        sandbox_likely: std::env::consts::OS == "linux" && uid != Some(0),
        runtime: "native".into(),
    }
}

fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        extern "C" {
            fn getuid() -> u32;
        }
        Some(unsafe { getuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[derive(Clone)]
pub struct HostPaths {
    pub root: PathBuf,
    pub kernel_root: PathBuf,
    pub downloads: PathBuf,
    pub profiles: PathBuf,
    pub status: PathBuf,
    pub runtimes: PathBuf,
    pub token: PathBuf,
    pub manifest: PathBuf,
}

impl HostPaths {
    pub fn new(cwd: &Path) -> Self {
        let root = cwd.join("data");
        let kernel_root = root.join("kernels");
        Self {
            downloads: kernel_root.join("downloads"),
            profiles: root.join("profiles"),
            status: kernel_root.join("status.json"),
            runtimes: root.join("runtimes.json"),
            token: root.join("host.token"),
            kernel_root,
            root,
            manifest: cwd.join("kernels.manifest.json"),
        }
    }
}

pub fn load_manifest(path: &Path) -> Result<ManifestFile> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn kernel_for_this_os(manifest: &ManifestFile) -> Result<&KernelRecord> {
    let platform = if cfg!(windows) {
        "win-x64"
    } else if cfg!(target_os = "macos") {
        "mac-arm64"
    } else {
        "linux-x64"
    };
    manifest
        .kernels
        .iter()
        .find(|k| k.platform == platform && !k.sha256.is_empty())
        .with_context(|| format!("no hashed kernel for {platform}"))
}

pub fn stable_linux(manifest: &ManifestFile) -> Result<&KernelRecord> {
    kernel_for_this_os(manifest)
}

pub fn force_headless() -> bool {
    if std::env::var_os("ENCLAVE_HEADLESS").is_some() {
        return true;
    }
    cfg!(unix)
        && std::env::var_os("DISPLAY").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_none()
}

pub async fn ensure_dirs(paths: &HostPaths) -> Result<()> {
    tokio::fs::create_dir_all(&paths.downloads).await?;
    tokio::fs::create_dir_all(&paths.profiles).await?;
    tokio::fs::create_dir_all(&paths.kernel_root).await?;
    Ok(())
}

pub fn archive_path(paths: &HostPaths, k: &KernelRecord) -> PathBuf {
    paths.downloads.join(&k.filename)
}

pub fn extract_dir(paths: &HostPaths, k: &KernelRecord) -> PathBuf {
    paths.kernel_root.join(format!("{}-{}", k.id, k.version))
}

pub async fn sha256_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn sha256_str(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn find_chrome(dir: &Path) -> Option<PathBuf> {
    let names = ["chrome", "chromium", "ungoogled-chromium", "chrome-wrapper"];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&cur) else { continue };
        for ent in rd.flatten() {
            let p = ent.path();
            let name = ent.file_name();
            let name = name.to_string_lossy();
            let lower = name.to_ascii_lowercase();
            if p.is_dir() {
                if name != "resources" && name != "locales" {
                    stack.push(p);
                }
            } else if names.iter().any(|n| *n == name)
                || lower == "chrome.exe"
                || lower == "chromium.exe"
                || lower == "ungoogled-chromium.exe"
            {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
                }
                return Some(p);
            }
        }
    }
    None
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

async fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_window(&mut kill);
        let _ = kill.status().await;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status().await;
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status().await;
    }
}

async fn extract_archive(archive: &Path, dest: &Path) -> Result<()> {
    let name = archive
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.ends_with(".zip") {
        #[cfg(windows)]
        {
            let archive = archive.display().to_string().replace('\'', "''");
            let dest = dest.display().to_string().replace('\'', "''");
            let mut cmd = Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-Command",
                &format!("Expand-Archive -LiteralPath '{archive}' -DestinationPath '{dest}' -Force"),
            ]);
            hide_window(&mut cmd);
            let out = cmd.output().await?;
            if !out.status.success() {
                bail!("unzip: {}", String::from_utf8_lossy(&out.stderr));
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            let out = Command::new("unzip")
                .args(["-o", archive.to_str().unwrap(), "-d", dest.to_str().unwrap()])
                .output()
                .await?;
            if !out.status.success() {
                bail!("unzip: {}", String::from_utf8_lossy(&out.stderr));
            }
            return Ok(());
        }
    }
    let out = Command::new("tar")
        .args([
            "--no-same-owner",
            "-xJf",
            archive.to_str().unwrap(),
            "-C",
            dest.to_str().unwrap(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if !out.status.success() {
        bail!("tar: {}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(())
}

pub fn resolve_executable(paths: &HostPaths, k: &KernelRecord) -> Option<PathBuf> {
    find_chrome(&extract_dir(paths, k))
}

async fn apply_search_engine(
    user_data_dir: &Path,
    engine: Option<&str>,
    provider: Option<&SearchProvider>,
) -> Result<Option<PathBuf>> {
    let ext_dir = user_data_dir.join("enclave-search");
    let policy_path = user_data_dir
        .join("policies")
        .join("managed")
        .join("enclave.json");
    let chosen = resolve_search_provider(engine, provider);
    if chosen.is_none() {
        let _ = tokio::fs::remove_dir_all(&ext_dir).await;
        let _ = tokio::fs::remove_file(&policy_path).await;
        return Ok(None);
    }
    let chosen = chosen.unwrap();
    tokio::fs::create_dir_all(&ext_dir).await?;
    let favicon = favicon_url_for(&chosen.keyword, &chosen.url);
    let mut provider = json!({
        "name": chosen.name,
        "keyword": chosen.keyword,
        "search_url": chosen.url,
        "favicon_url": favicon,
        "encoding": "UTF-8",
        "is_default": true
    });
    if !chosen.suggest_url.is_empty() {
        provider["suggest_url"] = json!(chosen.suggest_url);
    }
    let manifest = json!({
        "manifest_version": 3,
        "name": "Enclave Search",
        "version": "1.0.0",
        "chrome_settings_overrides": {
            "search_provider": provider
        }
    });
    tokio::fs::write(ext_dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?).await?;
    Ok(Some(ext_dir))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProvider {
    pub name: String,
    pub keyword: String,
    pub url: String,
    #[serde(default)]
    pub suggest_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEngineRow {
    pub name: String,
    pub keyword: String,
    pub url: String,
    pub suggest_url: String,
    pub is_default: bool,
    pub id: String,
}

fn preset_provider(engine: &str) -> Option<SearchProvider> {
    match engine.to_ascii_lowercase().as_str() {
        "google" => Some(SearchProvider {
            name: "Google".into(),
            keyword: "google.com".into(),
            url: "https://www.google.com/search?q={searchTerms}".into(),
            suggest_url: "https://www.google.com/complete/search?client=chrome&q={searchTerms}".into(),
        }),
        "bing" => Some(SearchProvider {
            name: "Microsoft Bing".into(),
            keyword: "bing.com".into(),
            url: "https://www.bing.com/search?q={searchTerms}".into(),
            suggest_url: "https://www.bing.com/osjson.aspx?query={searchTerms}".into(),
        }),
        "baidu" => Some(SearchProvider {
            name: "百度".into(),
            keyword: "baidu.com".into(),
            url: "https://www.baidu.com/s?wd={searchTerms}".into(),
            suggest_url: String::new(),
        }),
        "duckduckgo" | "ddg" => Some(SearchProvider {
            name: "DuckDuckGo".into(),
            keyword: "duckduckgo.com".into(),
            url: "https://duckduckgo.com/?q={searchTerms}".into(),
            suggest_url: "https://duckduckgo.com/ac/?q={searchTerms}&type=list".into(),
        }),
        _ => None,
    }
}

fn resolve_search_provider(engine: Option<&str>, provider: Option<&SearchProvider>) -> Option<SearchProvider> {
    if let Some(p) = provider {
        if p.url.contains("{searchTerms}") && !p.url.starts_with("http://{") {
            return Some(p.clone());
        }
    }
    preset_provider(engine.unwrap_or("none"))
}

fn favicon_url_for(keyword: &str, url: &str) -> String {
    let hay = format!("{} {}", keyword, url).to_ascii_lowercase();
    if hay.contains("google") {
        "https://www.google.com/favicon.ico".into()
    } else if hay.contains("bing") {
        "https://www.bing.com/favicon.ico".into()
    } else if hay.contains("baidu") {
        "https://www.baidu.com/favicon.ico".into()
    } else if hay.contains("duckduckgo") {
        "https://duckduckgo.com/favicon.ico".into()
    } else if hay.contains("sogou") {
        "https://www.sogou.com/favicon.ico".into()
    } else if hay.contains("so.com") {
        "https://www.so.com/favicon.ico".into()
    } else {
        "https://www.google.com/favicon.ico".into()
    }
}

pub fn list_search_engines(paths: &HostPaths, env_id: &str) -> Vec<SearchEngineRow> {
    let user_data = paths.profiles.join(format!("env_{env_id}")).join("user-data");
    let mut rows = profile_search_engines(&user_data);
    let default_kw = rows
        .iter()
        .find(|r| r.is_default)
        .map(|r| r.keyword.clone())
        .unwrap_or_else(|| "nosearch".into());
    for preset in ["google", "bing", "baidu", "duckduckgo"] {
        if let Some(p) = preset_provider(preset) {
            if !rows.iter().any(|r| r.keyword.eq_ignore_ascii_case(&p.keyword) || r.url == p.url) {
                rows.push(SearchEngineRow {
                    id: preset.into(),
                    name: p.name,
                    keyword: p.keyword,
                    url: p.url,
                    suggest_url: p.suggest_url,
                    is_default: false,
                });
            }
        }
    }
    if !rows.iter().any(|r| r.keyword.eq_ignore_ascii_case("nosearch")) {
        rows.insert(
            0,
            SearchEngineRow {
                id: "none".into(),
                name: "No Search".into(),
                keyword: "nosearch".into(),
                url: "http://{searchTerms}".into(),
                suggest_url: String::new(),
                is_default: default_kw == "nosearch" && !rows.iter().any(|r| r.is_default),
            },
        );
    }
    rows
}

fn profile_search_engines(user_data: &Path) -> Vec<SearchEngineRow> {
    let web = user_data.join("Default").join("Web Data");
    if !web.exists() {
        return vec![];
    }
    let tmp = user_data.join("Default").join("WebData.enclave-read");
    if std::fs::copy(&web, &tmp).is_err() {
        return vec![];
    }
    let default_kw = default_search_keyword(user_data);
    let mut rows = vec![];
    if let Ok(conn) = rusqlite::Connection::open_with_flags(
        &tmp,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        let sql = "SELECT short_name, keyword, url, IFNULL(suggest_url,'') FROM keywords WHERE url IS NOT NULL AND trim(url) != ''";
        let sql_fallback = "SELECT short_name, keyword, url FROM keywords WHERE url IS NOT NULL AND trim(url) != ''";
        let mut with_suggest = true;
        let stmt = conn.prepare(sql).or_else(|_| {
            with_suggest = false;
            conn.prepare(sql_fallback)
        });
        if let Ok(mut stmt) = stmt {
            let mapped = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                    if with_suggest {
                        row.get::<_, String>(3).unwrap_or_default()
                    } else {
                        String::new()
                    },
                ))
            });
            if let Ok(iter) = mapped {
                for item in iter.flatten() {
                    let (name, keyword, url, suggest) = item;
                    let id = engine_id_from_keyword(&keyword, &url);
                    let is_default = (!default_kw.is_empty() && keyword.eq_ignore_ascii_case(&default_kw))
                        || (default_kw.is_empty() && keyword.eq_ignore_ascii_case("nosearch"));
                    rows.push(SearchEngineRow {
                        id,
                        name,
                        keyword,
                        url,
                        suggest_url: suggest,
                        is_default,
                    });
                }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    rows
}

fn default_search_keyword(user_data: &Path) -> String {
    let path = user_data.join("Default").join("Preferences");
    let Ok(raw) = std::fs::read_to_string(path) else { return String::new() };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return String::new() };
    v.pointer("/default_search_provider_data/template_url_data/keyword")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn engine_id_from_keyword(keyword: &str, url: &str) -> String {
    let k = keyword.to_ascii_lowercase();
    let u = url.to_ascii_lowercase();
    if k == "nosearch" || u.starts_with("http://{searchterms}") {
        "none".into()
    } else if k.contains("google") || u.contains("google.com/search") {
        "google".into()
    } else if k.contains("bing") || u.contains("bing.com/search") {
        "bing".into()
    } else if k.contains("baidu") || u.contains("baidu.com") {
        "baidu".into()
    } else if k.contains("duckduckgo") || u.contains("duckduckgo.com") {
        "duckduckgo".into()
    } else {
        k
    }
}

pub async fn persist_status(paths: &HostPaths, status: &KernelStatus) -> Result<()> {
    tokio::fs::write(&paths.status, serde_json::to_vec_pretty(status)?).await?;
    Ok(())
}

pub async fn persist_runtimes(paths: &HostPaths, rows: &[RuntimeRow]) -> Result<()> {
    tokio::fs::write(&paths.runtimes, serde_json::to_vec_pretty(rows)?).await?;
    Ok(())
}

pub async fn verify_on_disk(paths: &HostPaths, k: &KernelRecord) -> (bool, Option<String>, Option<String>) {
    if k.sha256.is_empty() {
        return (false, None, Some("KERNEL_UNTRUSTED_SOURCE: empty hash".into()));
    }
    let archive = archive_path(paths, k);
    if !archive.exists() {
        return (false, None, Some("KERNEL_UNTRUSTED_SOURCE: archive missing".into()));
    }
    let meta = match std::fs::metadata(&archive) {
        Ok(m) => m,
        Err(e) => return (false, None, Some(e.to_string())),
    };
    if meta.len() != k.bytes {
        return (false, None, Some(format!("size {} != {}", meta.len(), k.bytes)));
    }
    let actual = match sha256_file(&archive).await {
        Ok(h) => h,
        Err(e) => return (false, None, Some(e.to_string())),
    };
    if actual != k.sha256 {
        return (false, Some(actual), Some("KERNEL_HASH_MISMATCH".into()));
    }
    if resolve_executable(paths, k).is_none() {
        return (false, Some(actual), Some("executable missing after extract".into()));
    }
    (true, Some(actual), None)
}

pub async fn read_status_fast(paths: &HostPaths, k: &KernelRecord) -> KernelStatus {
    let mut status = KernelStatus {
        state: "absent".into(),
        bytes_received: 0,
        bytes_expected: k.bytes,
        sha256_expected: k.sha256.clone(),
        sha256_actual: None,
        signature: "missing".into(),
        executable: None,
        error: None,
        admitted_at: None,
    };
    if let Ok(raw) = tokio::fs::read_to_string(&paths.status).await {
        if let Ok(parsed) = serde_json::from_str::<KernelStatus>(&raw) {
            status = parsed;
        }
    }
    let archive = archive_path(paths, k);
    let size = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
    let exe = resolve_executable(paths, k).map(|p| p.to_string_lossy().into_owned());
    let hash_cached = status.sha256_actual.as_deref() == Some(k.sha256.as_str());
    if exe.is_some() && size == k.bytes && hash_cached {
        status.state = "admitted".into();
        status.executable = exe;
        status.bytes_received = size;
        status.bytes_expected = k.bytes;
        status.sha256_expected = k.sha256.clone();
        return status;
    }
    status.bytes_received = size;
    status.executable = exe;
    if size == 0 {
        status.state = "absent".into();
    }
    status
}

pub async fn admit(
    paths: &HostPaths,
    k: &KernelRecord,
    status: &std::sync::Arc<tokio::sync::Mutex<KernelStatus>>,
) -> Result<()> {
    if k.sha256.is_empty() {
        bail!("KERNEL_UNTRUSTED_SOURCE: empty hash");
    }
    let archive = archive_path(paths, k);
    {
        let mut s = status.lock().await;
        s.state = "downloading".into();
        s.bytes_received = 0;
        s.bytes_expected = k.bytes;
        s.sha256_expected = k.sha256.clone();
        s.error = None;
        let _ = persist_status(paths, &s).await;
    }
    if !archive.exists() || std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0) != k.bytes {
        let tmp = archive.with_extension("part");
        let client = reqwest::Client::builder()
            .user_agent("EnclaveHost/0.1")
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()?;
        let mut resp = client.get(&k.url).send().await?;
        if !resp.status().is_success() {
            bail!("download HTTP {}", resp.status());
        }
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut received = 0u64;
        while let Some(chunk) = resp.chunk().await? {
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            let mut s = status.lock().await;
            s.bytes_received = received;
            s.state = "downloading".into();
        }
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, &archive).await?;
    }
    {
        let mut s = status.lock().await;
        s.state = "verifying".into();
        let _ = persist_status(paths, &s).await;
    }
    let actual = sha256_file(&archive).await?;
    if actual != k.sha256 {
        let mut s = status.lock().await;
        s.state = "hash_mismatch".into();
        s.sha256_actual = Some(actual);
        s.error = Some("KERNEL_HASH_MISMATCH".into());
        persist_status(paths, &s).await?;
        bail!("KERNEL_HASH_MISMATCH");
    }
    {
        let mut s = status.lock().await;
        s.state = "extracting".into();
        s.sha256_actual = Some(actual.clone());
        let _ = persist_status(paths, &s).await;
    }
    if resolve_executable(paths, k).is_none() {
        let dest = extract_dir(paths, k);
        if dest.exists() {
            tokio::fs::remove_dir_all(&dest).await.ok();
        }
        tokio::fs::create_dir_all(&dest).await?;
        extract_archive(&archive, &dest).await?;
    }
    let exe = resolve_executable(paths, k).context("chrome executable not found")?;
    let mut s = status.lock().await;
    *s = KernelStatus {
        state: "admitted".into(),
        bytes_received: k.bytes,
        bytes_expected: k.bytes,
        sha256_expected: k.sha256.clone(),
        sha256_actual: Some(actual),
        signature: "missing".into(),
        executable: Some(exe.to_string_lossy().into_owned()),
        error: None,
        admitted_at: Some(now_ms()),
    };
    persist_status(paths, &s).await?;
    Ok(())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn pick_port() -> Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

pub struct Spawned {
    pub pid: u32,
    pub port: u16,
    pub sha256: String,
    pub user_data_dir: PathBuf,
    pub warned: Vec<String>,
}

pub async fn start_environment(
    paths: &HostPaths,
    k: &KernelRecord,
    env_id: &str,
    profile: &FingerprintProfile,
    extra_flags: &[String],
    allow_no_sandbox: bool,
    proxy_server: Option<&str>,
    search_engine: Option<&str>,
    search_provider: Option<&SearchProvider>,
    runtimes: &std::sync::Arc<tokio::sync::Mutex<HashMap<String, RuntimeRow>>>,
) -> Result<Spawned, (String, String)> {
    {
        let map = runtimes.lock().await;
        if let Some(rt) = map.get(env_id) {
            if pid_alive(rt.pid) && wait_for_cdp(rt.port, 1500).await {
                return Ok(Spawned {
                    pid: rt.pid,
                    port: rt.port,
                    sha256: rt.sha256.clone(),
                    user_data_dir: PathBuf::from(&rt.user_data_dir),
                    warned: vec![],
                });
            }
        }
    }
    let (ok, actual, reason) = verify_on_disk(paths, k).await;
    if !ok {
        let code = if reason.as_deref().unwrap_or("").contains("HASH") {
            "KERNEL_HASH_MISMATCH"
        } else {
            "KERNEL_UNTRUSTED_SOURCE"
        };
        return Err((code.into(), reason.unwrap_or_else(|| "verify failed".into())));
    }
    let exe = resolve_executable(paths, k).ok_or_else(|| {
        ("KERNEL_UNTRUSTED_SOURCE".into(), "executable missing".into())
    })?;
    let port = pick_port().await.map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;
    let user_data_dir = paths.profiles.join(format!("env_{env_id}")).join("user-data");
    tokio::fs::create_dir_all(&user_data_dir)
        .await
        .map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;
    let search_ext = apply_search_engine(&user_data_dir, search_engine, search_provider)
        .await
        .map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;

    let mut args = vec![
        format!("--user-data-dir={}", user_data_dir.display()),
        format!("--fingerprint={}", profile.seed),
        format!("--fingerprint-platform={}", profile.platform),
        format!("--fingerprint-platform-version={}", profile.platform_version),
        format!("--fingerprint-brand={}", profile.brand),
        format!("--fingerprint-brand-version={}", profile.brand_version),
        format!("--fingerprint-hardware-concurrency={}", profile.hardware_concurrency),
        format!("--lang={}", profile.locale),
        format!("--accept-lang={}", profile.languages.join(",")),
        format!("--timezone={}", profile.timezone),
        format!("--window-size={},{}", profile.screen.width, profile.screen.height),
        format!("--remote-debugging-port={port}"),
        "--remote-debugging-address=127.0.0.1".into(),
        "--remote-allow-origins=http://127.0.0.1".into(),
        "--disable-non-proxied-udp".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-sync".into(),
        "--mute-audio".into(),
    ];
    if let Some(ext) = search_ext {
        args.push(format!("--load-extension={}", ext.display()));
    }
    if force_headless() {
        args.push("--headless=new".into());
        args.push("--disable-gpu".into());
    }
    if profile.webrtc.mode == "disable" {
        args.push("--disable-webrtc".into());
    } else {
        args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into());
    }
    if !profile.disable_spoofing.is_empty() {
        args.push(format!("--disable-spoofing={}", profile.disable_spoofing.join(",")));
    }
    if let Some(p) = proxy_server {
        args.push(format!("--proxy-server={p}"));
    }
    if allow_no_sandbox {
        args.push("--no-sandbox".into());
        args.push("--disable-gpu-sandbox".into());
    }
    let extra: Vec<String> = extra_flags
        .iter()
        .map(|f| if f.starts_with("--") { f.clone() } else { format!("--{f}") })
        .collect();
    let classified: Vec<_> = extra.iter().map(|f| classify(f)).collect();
    let rejected: Vec<String> = classified.iter().filter(|c| c.class == FlagClass::Reject).map(|c| c.raw.clone()).collect();
    let warned: Vec<String> = classified.iter().filter(|c| c.class == FlagClass::Warn).map(|c| c.raw.clone()).collect();
    if !rejected.is_empty() {
        return Err(("SANDBOX_DISABLED_BLOCKED".into(), format!("Rejected flags: {}", rejected.join(", "))));
    }
    args.extend(classified.into_iter().filter(|c| c.class != FlagClass::Reject).map(|c| c.raw));

    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .env("TZ", &profile.timezone);
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;
    let pid = child.id().ok_or_else(|| ("SPAWN_FAILED".into(), "no pid".into()))?;
    let stderr_buf = std::sync::Arc::new(tokio::sync::Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut tmp = vec![0u8; 4096];
            while let Ok(n) = err.read(&mut tmp).await {
                if n == 0 {
                    break;
                }
                let mut g = buf.lock().await;
                g.push_str(&String::from_utf8_lossy(&tmp[..n]));
                if g.len() > 8000 {
                    let cut = g.len() - 8000;
                    g.drain(..cut);
                }
            }
        });
    }
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    if !wait_for_cdp(port, 12000).await {
        kill_pid(pid).await;
        let stderr = stderr_buf.lock().await.clone();
        let sandbox_hint = !allow_no_sandbox
            && (stderr.to_lowercase().contains("no sandbox")
                || stderr.to_lowercase().contains("namespace")
                || stderr.to_lowercase().contains("zygote")
                || stderr.to_lowercase().contains("running as root"));
        if sandbox_hint {
            return Err((
                "SANDBOX_UNAVAILABLE".into(),
                "Chromium sandbox cannot start on this host. Acknowledge --no-sandbox to continue.".into(),
            ));
        }
        let tail: String = stderr.chars().rev().take(1200).collect::<String>().chars().rev().collect();
        return Err(("CDP_HANDSHAKE_FAILED".into(), if tail.is_empty() { "CDP did not come up".into() } else { tail }));
    }
    let sha = actual.unwrap_or_else(|| k.sha256.clone());
    let row = RuntimeRow {
        env_id: env_id.into(),
        pid,
        port,
        debug_address: "127.0.0.1".into(),
        started_at: now_ms(),
        sha256: sha.clone(),
        user_data_dir: user_data_dir.to_string_lossy().into_owned(),
    };
    {
        let mut map = runtimes.lock().await;
        map.insert(env_id.into(), row.clone());
        let rows: Vec<_> = map.values().cloned().collect();
        let _ = persist_runtimes(paths, &rows).await;
    }
    Ok(Spawned { pid, port, sha256: sha, user_data_dir, warned })
}

pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
            fn CloseHandle(handle: isize) -> i32;
            fn GetExitCodeProcess(handle: isize, exit_code: *mut u32) -> i32;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

pub async fn wait_for_cdp(port: u16, timeout_ms: u64) -> bool {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_millis(800)).build() else {
        return false;
    };
    let start = std::time::Instant::now();
    while (start.elapsed().as_millis() as u64) < timeout_ms {
        if let Ok(res) = client.get(&url).send().await {
            if res.status().is_success() {
                return true;
            }
        }
        sleep(Duration::from_millis(250)).await;
    }
    false
}

pub async fn stop_environment(
    paths: &HostPaths,
    env_id: &str,
    runtimes: &std::sync::Arc<tokio::sync::Mutex<HashMap<String, RuntimeRow>>>,
) -> Result<()> {
    let rt = { runtimes.lock().await.remove(env_id) };
    if let Some(rt) = rt {
        #[cfg(windows)]
        {
            kill_pid(rt.pid).await;
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-TERM", &format!("-{}", rt.pid)]).status().await;
            let _ = Command::new("kill").args(["-TERM", &rt.pid.to_string()]).status().await;
            sleep(Duration::from_millis(400)).await;
            let _ = Command::new("kill").args(["-KILL", &format!("-{}", rt.pid)]).status().await;
            let _ = Command::new("kill").args(["-KILL", &rt.pid.to_string()]).status().await;
        }
    }
    let rows: Vec<_> = runtimes.lock().await.values().cloned().collect();
    persist_runtimes(paths, &rows).await?;
    Ok(())
}

pub async fn restore_runtimes(
    paths: &HostPaths,
    runtimes: &std::sync::Arc<tokio::sync::Mutex<HashMap<String, RuntimeRow>>>,
) {
    let Ok(raw) = tokio::fs::read_to_string(&paths.runtimes).await else { return };
    let Ok(rows) = serde_json::from_str::<Vec<RuntimeRow>>(&raw) else { return };
    let mut map = runtimes.lock().await;
    for row in rows {
        if pid_alive(row.pid) && wait_for_cdp(row.port, 1500).await {
            map.insert(row.env_id.clone(), row);
        }
    }
}
