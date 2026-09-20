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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStatus {
    pub state: String,
    pub bytes_received: u64,
    pub bytes_expected: u64,
    /// 清单里写的压缩包哈希
    pub sha256_expected: String,
    /// 下载下来的压缩包实际算出的哈希
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256_actual: Option<String>,
    /// 解压后**真正会被执行**的那个文件的哈希。压缩包对不代表这个对，
    /// 所以准入时单独记一份，启动时核对的是它。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_sha256: Option<String>,
    /// 配合 exe_sha256 做便宜的完整性检查：大小或修改时间变了就重新算哈希。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_mtime: Option<u64>,
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
    pub os: String,
    pub arch: String,
    pub headless_forced: bool,
    pub sandbox_likely: bool,
}

pub fn capabilities() -> Capabilities {
    Capabilities {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        headless_forced: force_headless(),
        sandbox_likely: std::env::consts::OS == "linux" && current_uid() != Some(0),
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
        signal_tree(pid, SIGKILL);
    }
}

#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;

/// 给一个环境的进程组发信号（spawn 时用 process_group(0) 让它自成一组）。
///
/// 直接用 kill(2)，**绝不**经由外部 `kill` 命令：procps-ng 会用 getopt 把 `-12345`
/// 逐位拆成选项，先读到 `-1`，而 `kill -TERM -1` 是给系统上所有进程发信号 ——
/// 任何以 1 开头的 pid 都会触发，root 下等于把整台机器打挂。
/// pid <= 1 一律拒绝：0 是调用者自己的进程组，1 是 init，-1 是所有进程。
#[cfg(unix)]
fn signal_tree(pid: u32, sig: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let Ok(pid) = i32::try_from(pid) else { return };
    if pid <= 1 {
        return;
    }
    unsafe {
        kill(-pid, sig);
        kill(pid, sig);
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
    let policy_dir = user_data_dir.join("policies").join("managed");
    let policy_path = policy_dir.join("enclave.json");
    let chosen = resolve_search_provider(engine, provider);
    let _ = tokio::fs::remove_dir_all(&ext_dir).await;
    if chosen.is_none() {
        let _ = tokio::fs::remove_file(&policy_path).await;
        return Ok(None);
    }
    let chosen = chosen.unwrap();
    let favicon = favicon_url_for(&chosen.keyword, &chosen.url);
    tokio::fs::create_dir_all(&policy_dir).await?;
    let mut policy = json!({
        "DefaultSearchProviderEnabled": true,
        "DefaultSearchProviderName": chosen.name,
        "DefaultSearchProviderKeyword": chosen.keyword,
        "DefaultSearchProviderSearchURL": chosen.url,
        "DefaultSearchProviderFaviconURL": favicon,
        "DefaultSearchProviderEncodings": ["UTF-8"]
    });
    if !chosen.suggest_url.is_empty() {
        policy["DefaultSearchProviderSuggestURL"] = json!(chosen.suggest_url);
    }
    tokio::fs::write(&policy_path, serde_json::to_vec_pretty(&policy)?).await?;

    tokio::fs::create_dir_all(&ext_dir).await?;
    let mut search_provider = json!({
        "name": chosen.name,
        "keyword": chosen.keyword,
        "search_url": chosen.url,
        "favicon_url": favicon,
        "encoding": "UTF-8",
        "is_default": true
    });
    if !chosen.suggest_url.is_empty() {
        search_provider["suggest_url"] = json!(chosen.suggest_url);
    }
    let manifest = json!({
        "manifest_version": 3,
        "name": "Enclave Search",
        "version": "1.0.0",
        "chrome_settings_overrides": {
            "search_provider": search_provider
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

/// 文件大小与修改时间，用来做便宜的"没被动过"检查。
fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

/// 启动前的完整性检查。**检查对象是真正要执行的那个文件**，不是下载下来的压缩包 ——
/// 压缩包校验通过之后，磁盘上的解压结果仍然可能被改。
///
/// `full` 为真时重算 sha256（每个进程第一次启动环境时做一次）；
/// 否则只比对大小与修改时间，任何一项对不上就升级成全量校验。
pub async fn verify_executable(
    paths: &HostPaths,
    k: &KernelRecord,
    recorded: &KernelStatus,
    full: bool,
) -> Result<(PathBuf, String), (String, String)> {
    if k.sha256.is_empty() {
        return Err((
            "KERNEL_UNTRUSTED_SOURCE".into(),
            "清单里没有这个平台的哈希。".into(),
        ));
    }
    let Some(exe) = resolve_executable(paths, k) else {
        return Err((
            "KERNEL_UNTRUSTED_SOURCE".into(),
            "内核文件不在了，需要重新准入。".into(),
        ));
    };
    let Some(expected) = recorded.exe_sha256.clone() else {
        return Err((
            "KERNEL_UNTRUSTED_SOURCE".into(),
            "这个内核还没走过准入流程，先在内核页准入。".into(),
        ));
    };

    let stamp = file_stamp(&exe);
    let stamp_ok = match (stamp, recorded.exe_size, recorded.exe_mtime) {
        (Some((size, mtime)), Some(rs), Some(rm)) => size == rs && mtime == rm,
        _ => false,
    };

    if !full && stamp_ok {
        return Ok((exe, expected));
    }

    let actual = match sha256_file(&exe).await {
        Ok(h) => h,
        Err(e) => return Err(("KERNEL_UNTRUSTED_SOURCE".into(), e.to_string())),
    };
    if actual != expected {
        return Err((
            "KERNEL_HASH_MISMATCH".into(),
            "磁盘上的内核文件和准入时记录的哈希对不上，已拒绝启动。".into(),
        ));
    }
    Ok((exe, actual))
}

pub async fn read_status_fast(paths: &HostPaths, k: &KernelRecord) -> KernelStatus {
    let mut status = KernelStatus {
        state: "absent".into(),
        bytes_received: 0,
        bytes_expected: k.bytes,
        sha256_expected: k.sha256.clone(),
        sha256_actual: None,
        exe_sha256: None,
        exe_size: None,
        exe_mtime: None,
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
    let exe = resolve_executable(paths, k);

    // 这里只做便宜的判断给界面用：可执行文件在、大小和修改时间与准入时一致。
    // 真正的信任判断在 verify_executable —— 启动时才算数。
    let stamp_ok = match (exe.as_deref().and_then(file_stamp), status.exe_size, status.exe_mtime) {
        (Some((s, m)), Some(rs), Some(rm)) => s == rs && m == rm,
        _ => false,
    };
    if exe.is_some() && status.exe_sha256.is_some() && stamp_ok {
        status.state = "admitted".into();
        status.executable = exe.map(|p| p.to_string_lossy().into_owned());
        status.bytes_received = k.bytes;
        status.bytes_expected = k.bytes;
        status.sha256_expected = k.sha256.clone();
        return status;
    }

    status.bytes_received = size;
    status.executable = exe.map(|p| p.to_string_lossy().into_owned());
    if status.state == "admitted" {
        // 之前记的是"已准入"，但文件对不上了。不许继续显示绿灯。
        status.state = "error".into();
        status.error = Some("内核文件发生了变化，需要重新准入。".into());
    } else if size == 0 {
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

    // 每次准入都重新解压。之前是"目录里已经有 chrome 就跳过"，那样一个被替换过的
    // 解压目录会被直接沿用 —— 压缩包哈希对，跑起来的却不是那个文件。
    let dest = extract_dir(paths, k);
    if dest.exists() {
        tokio::fs::remove_dir_all(&dest).await.ok();
    }
    tokio::fs::create_dir_all(&dest).await?;
    extract_archive(&archive, &dest).await?;

    let exe = resolve_executable(paths, k).context("解压后找不到内核可执行文件")?;
    // 记下真正要执行的那个文件的哈希。以后每次启动核对的是它。
    let exe_sha = sha256_file(&exe).await?;
    let (exe_size, exe_mtime) = file_stamp(&exe).unwrap_or((0, 0));

    let mut s = status.lock().await;
    *s = KernelStatus {
        state: "admitted".into(),
        bytes_received: k.bytes,
        bytes_expected: k.bytes,
        sha256_expected: k.sha256.clone(),
        sha256_actual: Some(actual),
        exe_sha256: Some(exe_sha),
        exe_size: Some(exe_size),
        exe_mtime: Some(exe_mtime),
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
    full_verify: bool,
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
    // 启动前核对真正要执行的文件。第一次启动做全量 sha256，之后比对大小与修改时间。
    let recorded = read_status_fast(paths, k).await;
    let (exe, exe_sha) = verify_executable(paths, k, &recorded, full_verify).await?;
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
        args.push("--proxy-bypass-list=<-loopback>".into());
        args.push("--disable-quic".into());
        args.push("--dns-over-https-mode=off".into());
        args.push("--disable-features=UseDnsHttpsSvcb".into());
        args.push("--enable-features=SetIpv6ProbeFalse".into());
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
    // 记进运行态的是可执行文件的哈希 —— 也就是刚才真正核对过的那个值。
    let sha = exe_sha;
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
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        // 信号 0 只探测进程在不在，不发任何东西。pid <= 1 不可能是我们启动的内核。
        match i32::try_from(pid) {
            Ok(p) if p > 1 => unsafe { kill(p, 0) == 0 },
            _ => false,
        }
    }
}

#[cfg(all(test, unix))]
mod signal_tests {
    use super::*;

    /// 2026-09-20 的事故：stop_environment 调外部 `kill -TERM -<pid>`，procps 把它解析成
    /// `kill -TERM -1`，root 下给整台机器的所有进程发了 SIGTERM。
    #[test]
    fn never_signals_init_or_everyone() {
        // 这三个值如果真的发出去，测试进程自己（乃至整台机器）都会收到信号。
        // 能跑到断言就说明被挡住了。
        signal_tree(0, SIGTERM);
        signal_tree(1, SIGTERM);
        signal_tree(u32::MAX, SIGTERM);
        assert!(!pid_alive(0));
        assert!(!pid_alive(1));
    }

    #[test]
    fn kills_only_the_target_group() {
        use std::os::unix::process::CommandExt;
        let mut bystander = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let mut target = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        assert!(pid_alive(target.id()));

        signal_tree(target.id(), SIGKILL);
        let _ = target.wait();

        assert!(!pid_alive(target.id()), "目标应该被杀掉");
        assert!(pid_alive(bystander.id()), "无关进程必须活着");
        let _ = bystander.kill();
        let _ = bystander.wait();
    }

    #[test]
    fn source_never_shells_out_to_kill() {
        let src = include_str!("kernel.rs");
        let needle = ["Command::new(\"", "kill\")"].concat();
        assert!(!src.contains(&needle), "不许再通过外部 kill 命令发信号");
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
            signal_tree(rt.pid, SIGTERM);
            sleep(Duration::from_millis(400)).await;
            signal_tree(rt.pid, SIGKILL);
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
