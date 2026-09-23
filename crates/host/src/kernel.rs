use crate::api::StartSpec;
use crate::bridge::{self, Bridge, ExitInfo, Upstream};
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelRecord {
    /// 具体是哪个构建：`fingerprint-chromium` 或 `camoufox`。由内核的类决定，不能乱配。
    pub id: String,
    /// 内核分两类，每一类有自己的一串版本。
    pub engine: Engine,
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

/// 内核的类。两类的启动方式、指纹的给法、调试协议都不一样，但下载、校验、准入走的是同一条路。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    /// fingerprint-chromium：指纹经启动参数给，调试协议是 CDP。
    Chromium,
    /// Camoufox：指纹经环境变量里的一份 JSON 给，调试协议是 WebDriver BiDi。
    Firefox,
}

impl Engine {
    pub const ALL: [Engine; 2] = [Engine::Chromium, Engine::Firefox];

    /// 这一类用的构建。清单里的 `id` 必须是它。
    pub fn build_id(self) -> &'static str {
        match self {
            Engine::Chromium => "fingerprint-chromium",
            Engine::Firefox => "camoufox",
        }
    }

    /// 只从上游项目的 GitHub Release 下载。
    pub fn upstream_prefix(self) -> &'static str {
        match self {
            Engine::Chromium => {
                "https://github.com/adryfish/fingerprint-chromium/releases/download/"
            }
            Engine::Firefox => "https://github.com/daijro/camoufox/releases/download/",
        }
    }
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
    /// 这个环境跑的是哪个内核版本。正在用的版本不许删。
    #[serde(default)]
    pub kernel_version: String,
    /// 哪一类内核。采集、探活用的协议按它选。
    pub engine: Engine,
    /// 经代理出去之后外面看到的 IP 和位置。没配代理、或者没探到，就是空。
    #[serde(default)]
    pub exit: Option<ExitInfo>,
    /// 这个环境的流量走本进程里的代理桥。Host 一旦重启桥就没了，这样的浏览器接管回来也上不了网。
    #[serde(default)]
    pub bridged: bool,
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
    /// 浏览器窗口的大小。不是屏幕分辨率：实测内核 148 改不了 screen.width/height，
    /// 网页看到的始终是这台电脑真实的显示器。
    pub window: WindowSize,
    /// 下面三项只有 Firefox 类用得上：那一类的内核能按环境给屏幕、缩放和显卡字符串。
    /// Chromium 类给了也没用（内核改不了），工作台不会给。
    #[serde(default)]
    pub screen: Option<ScreenSpec>,
    #[serde(default)]
    pub device_pixel_ratio: Option<f64>,
    #[serde(default)]
    pub webgl: Option<WebglSpec>,
    pub webrtc: Webrtc,
    /// 定位怎么给。默认跟着代理出口走——时区和语言都跟了，定位不跟就是个矛盾。
    #[serde(default)]
    pub geolocation: Geolocation,
    #[serde(default)]
    pub disable_spoofing: Vec<String>,
}

/// 网页问"我在哪"的时候给什么。
#[derive(Clone, Debug, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum Geolocation {
    /// 跟着代理出口走。没绑代理、或者查不到出口坐标，就什么都不做。
    #[default]
    #[serde(rename = "exit")]
    FollowExit,
    /// 用户自己填的经纬度。
    #[serde(rename = "custom")]
    Custom { latitude: f64, longitude: f64 },
    /// 不动它：网页问到的是这台电脑真实的定位。
    #[serde(rename = "real")]
    Real,
    /// 禁用：网页根本要不到位置，和用户点了"拒绝"一样。
    #[serde(rename = "blocked")]
    Blocked,
    /// 旧名字，等同于"用真实位置"。留着是因为它进过一次界面。
    #[serde(rename = "off")]
    Off,
}

impl Geolocation {
    /// 这个环境最终要报的坐标。`exit` 是查出口得到的那一对。
    pub fn resolve(&self, exit: Option<(f64, f64)>) -> Option<(f64, f64)> {
        match self {
            Geolocation::FollowExit => exit,
            Geolocation::Custom {
                latitude,
                longitude,
            } => Some((*latitude, *longitude)),
            Geolocation::Real | Geolocation::Off | Geolocation::Blocked => None,
        }
    }

    /// 要不要把定位功能整个关掉。关掉之后网页拿到的是"用户拒绝了"。
    pub fn blocked(&self) -> bool {
        matches!(self, Geolocation::Blocked)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSpec {
    pub width: u32,
    pub height: u32,
    pub avail_width: u32,
    pub avail_height: u32,
    pub color_depth: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WebglSpec {
    pub vendor: String,
    pub renderer: String,
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

pub fn this_platform() -> &'static str {
    if cfg!(windows) {
        "win-x64"
    } else if cfg!(target_os = "macos") {
        "mac-arm64"
    } else {
        "linux-x64"
    }
}

/// 版本号会被拼进本机路径（解压目录、准入记录）。
/// 形状是"数字和点"，后面可以带一段预发布标记：`148.0.7778.215`、`152.0.4-beta.30`。
/// 不许出现路径分隔符、连续的点，也不许以点或连字符开头结尾。
pub fn valid_version(version: &str) -> bool {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let dotted =
        |s: &str, ok: fn(u8) -> bool| s.split('.').all(|p| !p.is_empty() && p.bytes().all(ok));
    !version.is_empty()
        && version.len() <= 32
        && dotted(core, |b| b.is_ascii_digit())
        && pre.is_none_or(|p| dotted(p, |b| b.is_ascii_alphanumeric()))
}

/// "148.0.7778.215" → [148, 0, 7778, 215]；"152.0.4-beta.30" → [152, 0, 4, 30]。用来比较新旧。
pub fn version_key(version: &str) -> Vec<u64> {
    version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

/// 清单里这个系统能用的全部内核，新的在前。同一个版本只留一条。
pub fn kernels_for_this_os(manifest: &ManifestFile) -> Vec<KernelRecord> {
    let mut list: Vec<KernelRecord> = manifest
        .kernels
        .iter()
        .filter(|k| k.platform == this_platform() && !k.sha256.is_empty())
        .cloned()
        .collect();
    list.sort_by_key(|k| std::cmp::Reverse(version_key(&k.version)));
    list.dedup_by(|a, b| a.version == b.version);
    list
}

/// 这一类内核新建环境默认用哪个版本：最新的稳定版；没有稳定版就用最新的。`kernels` 是新的在前。
pub fn default_version(kernels: &[KernelRecord], engine: Engine) -> Option<String> {
    let mut of_class = kernels.iter().filter(|k| k.engine == engine);
    let newest = of_class.clone().next();
    of_class
        .find(|k| k.channel == "stable")
        .or(newest)
        .map(|k| k.version.clone())
}

/// 环境 id 会被拼进文件路径（profiles/env_<id>），purge 还会对它 remove_dir_all。
/// 只认字母数字、下划线和连字符，`..`、斜杠、空串一律不行。
pub fn valid_env_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 彻底删除一个环境在磁盘上的全部数据：Cookie、登录态、缓存。调用前要先停掉它。
pub async fn purge_environment(paths: &HostPaths, env_id: &str) -> Result<()> {
    if !valid_env_id(env_id) {
        bail!("invalid environment id");
    }
    let dir = paths.profiles.join(format!("env_{env_id}"));
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    Ok(())
}

pub fn force_headless() -> bool {
    if std::env::var_os("ENCLAVE_HEADLESS").is_some() {
        return true;
    }
    // 没有 DISPLAY 就是没有桌面 —— 这只对 Linux 成立。macOS 从来没有这个变量，
    // 照这个判断 Mac 上的每个环境都会被悄悄开成无头。
    cfg!(all(unix, not(target_os = "macos")))
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

/// 每个版本各有一份准入记录，和它的解压目录放在一起。
pub fn status_path(paths: &HostPaths, k: &KernelRecord) -> PathBuf {
    paths
        .kernel_root
        .join(format!("{}-{}.status.json", k.id, k.version))
}

/// 准入成功时把这个版本的清单记录存在它旁边。以后清单里没有它了（厂商下架、
/// 或者新安装包不再自带这个旧版本），已经下载的这份照样认得、照样能用。
pub fn record_path(paths: &HostPaths, k: &KernelRecord) -> PathBuf {
    paths
        .kernel_root
        .join(format!("{}-{}.record.json", k.id, k.version))
}

/// 本机下载过、并且文件还在的全部版本。
pub fn saved_records(paths: &HostPaths) -> Vec<KernelRecord> {
    let Ok(dir) = std::fs::read_dir(&paths.kernel_root) else {
        return Vec::new();
    };
    dir.flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".record.json"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|raw| serde_json::from_slice::<KernelRecord>(&raw).ok())
        .filter(|k| k.platform == this_platform() && resolve_executable(paths, k).is_some())
        .collect()
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

/// 解压目录里真正被执行的那个文件叫什么。各平台的包都实际看过目录：
/// Chromium 类：Linux `chrome`，Windows `chrome.exe`，macOS `Chromium.app/Contents/MacOS/Chromium`；
/// Firefox 类：Linux `camoufox-bin`，Windows `camoufox.exe`，macOS `Camoufox.app/Contents/MacOS/camoufox`。
/// macOS 不走这张表，它只认 .app/Contents/MacOS 里的那个文件。
#[cfg(not(target_os = "macos"))]
fn executable_names(engine: Engine) -> &'static [&'static str] {
    match engine {
        // 不含 chrome-wrapper：那是个壳脚本，准入时记下的哈希必须是真正执行的那个文件。
        Engine::Chromium => &[
            "chrome",
            "chromium",
            "ungoogled-chromium",
            "chrome.exe",
            "chromium.exe",
            "ungoogled-chromium.exe",
        ],
        // 不含 Linux 包里的 `camoufox`：那是启动器，真正的浏览器是 camoufox-bin。
        Engine::Firefox => &["camoufox-bin", "camoufox.exe"],
    }
}

/// macOS 的内核是一个 .app 包，真正执行的文件在 Contents/MacOS/ 里。
/// 包里别处还有 Helper 之类的可执行文件，不能按名字满树去撞。
#[cfg(target_os = "macos")]
fn find_executable(dir: &Path, engine: Engine) -> Option<PathBuf> {
    let inner = match engine {
        Engine::Chromium => "Chromium",
        Engine::Firefox => "camoufox",
    };
    let rd = std::fs::read_dir(dir).ok()?;
    for ent in rd.flatten() {
        let app = ent.path();
        if app.extension().and_then(|e| e.to_str()) != Some("app") {
            continue;
        }
        let exe = app.join("Contents").join("MacOS").join(inner);
        if exe.is_file() {
            return Some(exe);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn find_executable(dir: &Path, engine: Engine) -> Option<PathBuf> {
    let names = executable_names(engine);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&cur) else {
            continue;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            let name = ent.file_name();
            let name = name.to_string_lossy();
            let lower = name.to_ascii_lowercase();
            if p.is_dir() {
                if name != "resources" && name != "locales" {
                    stack.push(p);
                }
            } else if names.iter().any(|n| *n == name || *n == lower) {
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
    if name.ends_with(".dmg") {
        #[cfg(target_os = "macos")]
        return extract_dmg(archive, dest).await;
        #[cfg(not(target_os = "macos"))]
        bail!("dmg 内核只能在 macOS 上解开");
    }
    if name.ends_with(".zip") {
        #[cfg(windows)]
        {
            let archive = archive.display().to_string().replace('\'', "''");
            let dest = dest.display().to_string().replace('\'', "''");
            let mut cmd = Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{archive}' -DestinationPath '{dest}' -Force"
                ),
            ]);
            hide_window(&mut cmd);
            let out = cmd.output().await?;
            if !out.status.success() {
                bail!("unzip: {}", String::from_utf8_lossy(&out.stderr));
            }
            return Ok(());
        }
        // macOS 上的 zip 里是一个 .app：用 ditto 解，保留签名和扩展属性（unzip 会丢）。
        #[cfg(target_os = "macos")]
        {
            let out = Command::new("ditto")
                .args(["-x", "-k"])
                .arg(archive)
                .arg(dest)
                .output()
                .await?;
            if !out.status.success() {
                bail!("ditto: {}", String::from_utf8_lossy(&out.stderr));
            }
            return Ok(());
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            let out = Command::new("unzip")
                .args([
                    "-o",
                    archive.to_str().unwrap(),
                    "-d",
                    dest.to_str().unwrap(),
                ])
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

/// 挂载 dmg，把里面的 .app 原样拷出来（ditto 会保留签名和扩展属性），再卸载。
/// 拷贝成不成功都要卸载，否则下次准入会挂载失败。
#[cfg(target_os = "macos")]
async fn extract_dmg(archive: &Path, dest: &Path) -> Result<()> {
    let mount = dest.with_extension("mount");
    let _ = tokio::fs::remove_dir_all(&mount).await;
    tokio::fs::create_dir_all(&mount).await?;
    let out = Command::new("hdiutil")
        .args([
            "attach",
            "-nobrowse",
            "-readonly",
            "-noautoopen",
            "-mountpoint",
        ])
        .arg(&mount)
        .arg(archive)
        .output()
        .await?;
    if !out.status.success() {
        bail!("hdiutil attach: {}", String::from_utf8_lossy(&out.stderr));
    }

    let copied = copy_app_bundle(&mount, dest).await;

    let _ = Command::new("hdiutil")
        .arg("detach")
        .arg(&mount)
        .arg("-force")
        .output()
        .await;
    let _ = tokio::fs::remove_dir_all(&mount).await;
    copied
}

#[cfg(target_os = "macos")]
async fn copy_app_bundle(mount: &Path, dest: &Path) -> Result<()> {
    let mut rd = tokio::fs::read_dir(mount).await?;
    while let Some(ent) = rd.next_entry().await? {
        let app = ent.path();
        if app.extension().and_then(|e| e.to_str()) != Some("app") {
            continue;
        }
        let out = Command::new("ditto")
            .arg(&app)
            .arg(dest.join(ent.file_name()))
            .output()
            .await?;
        if !out.status.success() {
            bail!("ditto: {}", String::from_utf8_lossy(&out.stderr));
        }
        return Ok(());
    }
    bail!("dmg 里没有 .app")
}

pub fn resolve_executable(paths: &HostPaths, k: &KernelRecord) -> Option<PathBuf> {
    find_executable(&extract_dir(paths, k), k.engine)
}

async fn apply_search_engine(
    user_data_dir: &Path,
    engine: Option<&str>,
    provider: Option<&SearchProvider>,
) -> Result<Option<PathBuf>> {
    let ext_dir = user_data_dir.join("enclave-search");
    let _ = tokio::fs::remove_dir_all(&ext_dir).await;
    let Some(chosen) = resolve_search_provider(engine, provider) else {
        return Ok(None);
    };
    let favicon = favicon_url_for(&chosen.keyword, &chosen.url);
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
    tokio::fs::write(
        ext_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )
    .await?;
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
            suggest_url: "https://www.google.com/complete/search?client=chrome&q={searchTerms}"
                .into(),
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

fn resolve_search_provider(
    engine: Option<&str>,
    provider: Option<&SearchProvider>,
) -> Option<SearchProvider> {
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
    let user_data = paths
        .profiles
        .join(format!("env_{env_id}"))
        .join("user-data");
    let mut rows = profile_search_engines(&user_data);
    let default_kw = rows
        .iter()
        .find(|r| r.is_default)
        .map(|r| r.keyword.clone())
        .unwrap_or_else(|| "nosearch".into());
    for preset in ["google", "bing", "baidu", "duckduckgo"] {
        if let Some(p) = preset_provider(preset) {
            if !rows
                .iter()
                .any(|r| r.keyword.eq_ignore_ascii_case(&p.keyword) || r.url == p.url)
            {
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
    if !rows
        .iter()
        .any(|r| r.keyword.eq_ignore_ascii_case("nosearch"))
    {
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
    if let Ok(conn) =
        rusqlite::Connection::open_with_flags(&tmp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    {
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
                    let is_default = (!default_kw.is_empty()
                        && keyword.eq_ignore_ascii_case(&default_kw))
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
    let Ok(raw) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return String::new();
    };
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

pub async fn persist_status(
    paths: &HostPaths,
    k: &KernelRecord,
    status: &KernelStatus,
) -> Result<()> {
    tokio::fs::write(status_path(paths, k), serde_json::to_vec_pretty(status)?).await?;
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
    if let Ok(raw) = tokio::fs::read_to_string(status_path(paths, k)).await {
        if let Ok(parsed) = serde_json::from_str::<KernelStatus>(&raw) {
            status = parsed;
        }
    }
    let archive = archive_path(paths, k);
    let size = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
    let exe = resolve_executable(paths, k);

    // 这里只做便宜的判断给界面用：可执行文件在、大小和修改时间与准入时一致。
    // 真正的信任判断在 verify_executable —— 启动时才算数。
    let stamp_ok = match (
        exe.as_deref().and_then(file_stamp),
        status.exe_size,
        status.exe_mtime,
    ) {
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
        // 过程中的状态只放内存。落盘的话，准入到一半进程被杀，下次启动会永远卡在"解压中"。
    }
    if !archive.exists() || std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0) != k.bytes {
        let tmp = archive.with_extension("part");
        // 读超时是"两次收到数据之间"的间隔，慢但在走的下载不受影响；
        // 没有它，一条半死的连接会让准入永远结束不了，用户只能重启。
        let client = reqwest::Client::builder()
            .user_agent("EnclaveHost/0.1")
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(60))
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
        status.lock().await.state = "verifying".into();
    }
    let actual = sha256_file(&archive).await?;
    if actual != k.sha256 {
        let mut s = status.lock().await;
        s.state = "hash_mismatch".into();
        s.sha256_actual = Some(actual);
        s.error = Some("KERNEL_HASH_MISMATCH".into());
        persist_status(paths, k, &s).await?;
        // 留着这个文件的话大小是对的，下次重试会跳过下载，再失败一次，永远如此。
        let _ = tokio::fs::remove_file(&archive).await;
        bail!("KERNEL_HASH_MISMATCH");
    }
    {
        let mut s = status.lock().await;
        s.state = "extracting".into();
        s.sha256_actual = Some(actual.clone());
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
    persist_status(paths, k, &s).await?;
    tokio::fs::write(record_path(paths, k), serde_json::to_vec_pretty(k)?).await?;
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

/// 每个带代理的环境一座桥，键是环境 id。桥和环境同生共死。
pub type Bridges = std::sync::Arc<tokio::sync::Mutex<HashMap<String, Bridge>>>;

pub struct Spawned {
    pub pid: u32,
    pub port: u16,
    pub exit: Option<ExitInfo>,
    /// 实际用来启动的时区和语言：可能已经按出口改过。
    pub timezone: String,
    pub locale: String,
    pub languages: Vec<String>,
    pub sha256: String,
    pub user_data_dir: PathBuf,
    pub warned: Vec<String>,
}

/// 这一次启动特有的两样东西，由调用方备好。
pub struct Launch<'a> {
    /// 本进程第一次用这个内核：把可执行文件完整算一遍哈希。
    pub full_verify: bool,
    /// 这个环境的代理地址（带账号密码）。从 Host 自己的存储里解出来，用完即弃。
    pub proxy_url: Option<&'a str>,
}

pub async fn start_environment(
    paths: &HostPaths,
    k: &KernelRecord,
    env_id: &str,
    spec: &StartSpec,
    runtimes: &std::sync::Arc<tokio::sync::Mutex<HashMap<String, RuntimeRow>>>,
    bridges: &Bridges,
    launch: Launch<'_>,
) -> Result<Spawned, (String, String)> {
    let Launch {
        full_verify,
        proxy_url,
    } = launch;
    let profile = &spec.profile;
    let allow_no_sandbox = spec.allow_no_sandbox;
    {
        let map = runtimes.lock().await;
        if let Some(rt) = map.get(env_id) {
            if pid_alive(rt.pid) && wait_ready(k.engine, rt.port, 1500).await {
                return Ok(Spawned {
                    pid: rt.pid,
                    port: rt.port,
                    exit: rt.exit.clone(),
                    timezone: profile.timezone.clone(),
                    locale: profile.locale.clone(),
                    languages: profile.languages.clone(),
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
    // 有代理就先架桥、先探路。不通就别开窗口：开出来也只是一个打不开网页的浏览器。
    let mut bridge = None;
    let mut exit = None;
    if let Some(url) = proxy_url {
        let upstream =
            Upstream::parse(url).map_err(|e| ("PROXY_INVALID".to_string(), format!("{e:#}")))?;
        let b = Bridge::start(upstream)
            .await
            .map_err(|e| ("SPAWN_FAILED".to_string(), e.to_string()))?;
        match bridge::probe(b.port).await {
            Ok(info) => exit = Some(info),
            Err(_) => {
                // 桥自己记下了连上游失败的原因，那才是要告诉用户的；
                // 上游是通的、只是查 IP 的服务都不通，就照常启动，只是不对齐时区。
                if let Some(f) = b.last_failure().await {
                    return Err((f.code.to_string(), f.message));
                }
            }
        }
        bridge = Some(b);
    }
    let timezone = exit
        .as_ref()
        .filter(|_| spec.follow_exit)
        .and_then(|e| e.timezone.clone())
        .unwrap_or_else(|| profile.timezone.clone());
    // 语言和时区成对走：出口在东京，时区改成了东京，语言还留着 en-US，是最常被看的不一致之一。
    let region = exit
        .as_ref()
        .filter(|_| spec.follow_exit)
        .and_then(|e| e.country.as_deref())
        .and_then(crate::region::of_country);
    let (locale, languages) = match region {
        Some(r) => (r.locale.clone(), r.languages.clone()),
        None => (profile.locale.clone(), profile.languages.clone()),
    };

    let port = pick_port()
        .await
        .map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;
    let user_data_dir = paths
        .profiles
        .join(format!("env_{env_id}"))
        .join("user-data");
    tokio::fs::create_dir_all(&user_data_dir)
        .await
        .map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;
    // 两类内核从这里分开：指纹的给法、代理的给法、调试协议都不一样。
    let (args, extra_env, warned): (Vec<String>, Vec<(String, String)>, Vec<String>) = match k
        .engine
    {
        Engine::Chromium => {
            let search_ext = apply_search_engine(
                &user_data_dir,
                spec.search_engine.as_deref(),
                spec.search_provider.as_ref(),
            )
            .await
            .map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;

            let mut args = vec![
                format!("--user-data-dir={}", user_data_dir.display()),
                format!("--fingerprint={}", profile.seed),
                format!("--fingerprint-platform={}", profile.platform),
                format!(
                    "--fingerprint-platform-version={}",
                    profile.platform_version
                ),
                format!("--fingerprint-brand={}", profile.brand),
                format!("--fingerprint-brand-version={}", profile.brand_version),
                format!(
                    "--fingerprint-hardware-concurrency={}",
                    profile.hardware_concurrency
                ),
                format!("--lang={locale}"),
                format!("--accept-lang={}", languages.join(",")),
                format!("--timezone={timezone}"),
                format!(
                    "--window-size={},{}",
                    profile.window.width, profile.window.height
                ),
                format!("--remote-debugging-port={port}"),
                "--remote-debugging-address=127.0.0.1".into(),
                "--remote-allow-origins=http://127.0.0.1".into(),
                "--disable-non-proxied-udp".into(),
                "--no-first-run".into(),
                "--no-default-browser-check".into(),
                "--disable-sync".into(),
                "--mute-audio".into(),
            ];
            if force_headless() {
                args.push("--headless=new".into());
                args.push("--disable-gpu".into());
            }
            if profile.webrtc.mode == "disable" {
                args.push("--disable-webrtc".into());
            } else {
                args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into());
            }
            // 关掉某一项伪装，让它露出这台电脑的真实值。实测 canvas 生效：关掉后和不带 --fingerprint 时一样。
            // 名字只许小写字母：它们会拼进同一个参数里。
            let real: Vec<&str> = profile
                .disable_spoofing
                .iter()
                .map(String::as_str)
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase()))
                .collect();
            if !real.is_empty() {
                args.push(format!("--disable-spoofing={}", real.join(",")));
            }
            if let Some(b) = &bridge {
                // 浏览器只认识本机这座桥；账号密码和上游地址都不出现在它的命令行里。
                args.push(format!("--proxy-server=socks5://127.0.0.1:{}", b.port));
                // 本机一律不做 DNS 查询（预解析也不行），域名全部交给代理出口去解析。
                args.push("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1".into());
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
            let mut extra: Vec<String> = spec
                .extra_flags
                .iter()
                .map(|f| {
                    if f.starts_with("--") {
                        f.clone()
                    } else {
                        format!("--{f}")
                    }
                })
                .collect();
            // 同名开关 Chromium 只认最后一个：搜索引擎扩展和用户的扩展必须并进同一个 --load-extension。
            if let Some(ext) = search_ext {
                let ours = ext.display().to_string();
                match extra
                    .iter_mut()
                    .find(|f| f.starts_with("--load-extension="))
                {
                    Some(flag) => {
                        flag.push(',');
                        flag.push_str(&ours);
                    }
                    None => extra.push(format!("--load-extension={ours}")),
                }
            }
            let classified: Vec<_> = extra.iter().map(|f| classify(f)).collect();
            let rejected: Vec<String> = classified
                .iter()
                .filter(|c| c.class == FlagClass::Reject)
                .map(|c| c.raw.clone())
                .collect();
            let warned: Vec<String> = classified
                .iter()
                .filter(|c| c.class == FlagClass::Warn)
                .map(|c| c.raw.clone())
                .collect();
            if !rejected.is_empty() {
                return Err((
                    "SANDBOX_DISABLED_BLOCKED".into(),
                    format!(
                        "这些启动参数不允许：{}。到环境的「启动参数」页删掉。",
                        rejected.join("、")
                    ),
                ));
            }
            args.extend(
                classified
                    .into_iter()
                    .filter(|c| c.class != FlagClass::Reject)
                    .map(|c| c.raw),
            );
            let mut env = vec![("TZ".to_string(), timezone.clone())];
            // Linux 上 Chromium 的界面语言（也就是 Intl 的默认区域）只看环境变量，不看 --lang。
            // 实测：只传 --lang=de 时 navigator.language 是 de-DE，Intl 却还是 en-US——两边对不上。
            // Windows 上 --lang 就够了。
            if cfg!(target_os = "linux") {
                env.push(("LANGUAGE".to_string(), locale.replace('-', "_")));
            }
            // macOS 上取的是系统语言。Cocoa 程序认命令行里的 `-AppleLanguages (xx-YY)`，
            // 它会盖掉系统设置——**没有 Mac 真机，这一条没验过**；实验室的一致性检查会指出来。
            if cfg!(target_os = "macos") {
                args.push("-AppleLanguages".to_string());
                args.push(format!("({locale})"));
            }
            (args, env, warned)
        }
        Engine::Firefox => {
            // 这一类不接受额外启动参数，也不装 Chromium 的扩展：两样都是 Chromium 的东西。
            if !spec.extra_flags.is_empty() {
                return Err((
                    "FLAGS_UNSUPPORTED".into(),
                    "Firefox 类内核不接受额外的启动参数，也不能加载 Chromium 扩展。到环境的「启动参数」页和扩展设置里清掉。".into(),
                ));
            }
            let plan = crate::firefox::Plan {
                kernel_version: &k.version,
                profile,
                timezone: &timezone,
                locale: &locale,
                languages: &languages,
                bridge_port: bridge.as_ref().map(|b| b.port),
                exit_ip: exit.as_ref().map(|e| e.ip.as_str()),
                exit_coords: profile
                    .geolocation
                    .resolve(exit.as_ref().and_then(|e| e.coords)),
                geo_blocked: profile.geolocation.blocked(),
            };
            tokio::fs::write(
                user_data_dir.join("user.js"),
                crate::firefox::user_js(&plan),
            )
            .await
            .map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;
            let mut env = crate::firefox::env_chunks(&crate::firefox::config(&plan), cfg!(windows));
            env.push(("TZ".to_string(), timezone.clone()));
            if cfg!(target_os = "linux") {
                if let Some(dir) = crate::firefox::fontconfig_path(&exe, &profile.platform) {
                    env.push(("FONTCONFIG_PATH".to_string(), dir.display().to_string()));
                }
            }
            let args = crate::firefox::args(
                &user_data_dir,
                port,
                (profile.window.width, profile.window.height),
                force_headless(),
            );
            (args, env, Vec::new())
        }
    };

    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .envs(extra_env);
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| ("SPAWN_FAILED".into(), e.to_string()))?;
    let pid = child
        .id()
        .ok_or_else(|| ("SPAWN_FAILED".into(), "no pid".into()))?;
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
    {
        // 用户直接关掉浏览器窗口是最常见的结束方式。进程一退就把这一行拿掉，
        // 否则它永远显示"运行中"、占着并发名额，之后点停止还会去杀一个早已易主的 pid。
        let (paths, runtimes, env_id) = (paths.clone(), runtimes.clone(), env_id.to_string());
        let bridges = bridges.clone();
        tokio::spawn(async move {
            let _ = child.wait().await;
            let mut map = runtimes.lock().await;
            if map.get(&env_id).map(|r| r.pid) == Some(pid) {
                map.remove(&env_id);
                bridges.lock().await.remove(&env_id);
                let rows: Vec<_> = map.values().cloned().collect();
                let _ = persist_runtimes(&paths, &rows).await;
            }
        });
    }
    // Firefox 类第一次用一个新 profile 启动要建一堆文件，给它多一点时间。
    if !wait_ready(
        k.engine,
        port,
        if k.engine == Engine::Firefox {
            30000
        } else {
            12000
        },
    )
    .await
    {
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
                "Chromium sandbox cannot start on this host. Acknowledge --no-sandbox to continue."
                    .into(),
            ));
        }
        let tail: String = stderr
            .chars()
            .rev()
            .take(1200)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err((
            "CDP_HANDSHAKE_FAILED".into(),
            if tail.is_empty() {
                "CDP did not come up".into()
            } else {
                tail
            },
        ));
    }
    // 记进运行态的是可执行文件的哈希 —— 也就是刚才真正核对过的那个值。
    let sha = exe_sha;
    let row = RuntimeRow {
        env_id: env_id.into(),
        kernel_version: k.version.clone(),
        engine: k.engine,
        exit: exit.clone(),
        bridged: bridge.is_some(),
        pid,
        port,
        debug_address: "127.0.0.1".into(),
        started_at: now_ms(),
        sha256: sha.clone(),
        user_data_dir: user_data_dir.to_string_lossy().into_owned(),
    };
    {
        let mut map = runtimes.lock().await;
        // 刚握完手就退出的浏览器，退出通知已经来过了，不会再来第二次；这时再登记就永远清不掉。
        if !pid_alive(pid) {
            return Err(("SPAWN_FAILED".into(), "浏览器刚启动就退出了。".into()));
        }
        map.insert(env_id.into(), row.clone());
        if let Some(b) = bridge {
            bridges.lock().await.insert(env_id.into(), b);
        }
        let rows: Vec<_> = map.values().cloned().collect();
        let _ = persist_runtimes(paths, &rows).await;
    }
    Ok(Spawned {
        pid,
        port,
        exit,
        timezone,
        locale,
        languages,
        sha256: sha,
        user_data_dir,
        warned,
    })
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

#[cfg(test)]
mod geolocation_tests {
    use super::*;

    /// 用户选什么就给什么。默认跟着出口——时区和语言都跟了，定位不跟就是个矛盾；
    /// 但明确关掉的时候，一个坐标都不许编。
    #[test]
    fn the_user_picks_what_the_page_is_told() {
        let berlin = Some((52.52, 13.405));

        assert_eq!(Geolocation::default(), Geolocation::FollowExit);
        assert_eq!(Geolocation::FollowExit.resolve(berlin), berlin);
        // 没绑代理就没有出口：跟随模式下什么都不做，用真实位置，不瞎编一个。
        assert_eq!(Geolocation::FollowExit.resolve(None), None);

        let tokyo = Geolocation::Custom {
            latitude: 35.68,
            longitude: 139.69,
        };
        // 自己填的优先于出口：用户说了算。
        assert_eq!(tokyo.resolve(berlin), Some((35.68, 139.69)));
        assert_eq!(tokyo.resolve(None), Some((35.68, 139.69)));

        // 关掉就是关掉，哪怕查到了出口坐标也不动。
        assert_eq!(Geolocation::Off.resolve(berlin), None);
        assert_eq!(Geolocation::Off.resolve(None), None);
    }

    /// 老的环境里没有这一项：要当成"跟随出口"，不能因为少个字段就启动不了。
    #[test]
    fn an_environment_without_the_field_follows_the_exit() {
        let profile: FingerprintProfile = serde_json::from_value(serde_json::json!({
            "seed": "1", "platform": "windows", "platformVersion": "19.0.0",
            "brand": "Chrome", "brandVersion": "148", "hardwareConcurrency": 8,
            "locale": "en-US", "languages": ["en-US"], "timezone": "UTC",
            "window": {"width": 1280, "height": 800}, "webrtc": {"mode": "replace"}
        }))
        .unwrap();
        assert_eq!(profile.geolocation, Geolocation::FollowExit);
    }
}

#[cfg(test)]
mod env_id_tests {
    use super::valid_env_id;

    #[test]
    fn rejects_anything_that_could_leave_the_profiles_dir() {
        for bad in [
            "",
            "..",
            "../x",
            "a/b",
            "a\\b",
            "env 1",
            "é",
            "x/../../etc",
            &"a".repeat(65),
        ] {
            assert!(!valid_env_id(bad), "{bad:?} 不该通过");
        }
    }

    #[test]
    fn accepts_the_ids_the_workbench_generates() {
        for ok in ["env_mfx3k2a9b1c2d3e4", "e1", "A-b_9"] {
            assert!(valid_env_id(ok), "{ok:?} 应该通过");
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
        let mut bystander = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
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

/// 浏览器起来了没有。Chromium 类看 CDP 的 /json/version；Firefox 类看 BiDi 的端口通没通
/// （它在浏览器启动完成之后才开始监听）。
pub async fn wait_ready(engine: Engine, port: u16, timeout_ms: u64) -> bool {
    match engine {
        Engine::Chromium => wait_for_cdp(port, timeout_ms).await,
        Engine::Firefox => {
            let start = std::time::Instant::now();
            while (start.elapsed().as_millis() as u64) < timeout_ms {
                if tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_ok()
                {
                    return true;
                }
                sleep(Duration::from_millis(250)).await;
            }
            false
        }
    }
}

pub async fn wait_for_cdp(port: u16, timeout_ms: u64) -> bool {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    else {
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
    bridges: &Bridges,
) -> Result<()> {
    let rt = { runtimes.lock().await.remove(env_id) };
    bridges.lock().await.remove(env_id);
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
    let Ok(raw) = tokio::fs::read_to_string(&paths.runtimes).await else {
        return;
    };
    let Ok(rows) = serde_json::from_str::<Vec<RuntimeRow>>(&raw) else {
        return;
    };
    for row in rows {
        if !pid_alive(row.pid) {
            continue;
        }
        if row.bridged {
            // 它的代理桥随上一个 Host 进程没了，留着也上不了网（不会漏：它只认那个已经关掉的本机端口）。
            kill_pid(row.pid).await;
            continue;
        }
        if wait_ready(row.engine, row.port, 1500).await {
            runtimes.lock().await.insert(row.env_id.clone(), row);
        }
    }
}

/// 删掉一个已下载的版本：解压目录、压缩包、下到一半的文件、准入记录。
pub async fn remove_kernel(paths: &HostPaths, k: &KernelRecord) -> Result<()> {
    let archive = archive_path(paths, k);
    let dir = extract_dir(paths, k);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    for file in [
        archive.with_extension("part"),
        archive,
        status_path(paths, k),
        record_path(paths, k),
    ] {
        if file.exists() {
            tokio::fs::remove_file(&file).await?;
        }
    }
    Ok(())
}

/// Host 重启后接管回来的浏览器不是它的子进程，等不到退出信号，只能看 pid 还在不在。
pub async fn prune_dead(
    paths: &HostPaths,
    runtimes: &std::sync::Arc<tokio::sync::Mutex<HashMap<String, RuntimeRow>>>,
) {
    let mut map = runtimes.lock().await;
    let before = map.len();
    map.retain(|_, row| pid_alive(row.pid));
    if map.len() != before {
        let rows: Vec<_> = map.values().cloned().collect();
        let _ = persist_runtimes(paths, &rows).await;
    }
}

#[cfg(test)]
mod version_tests {
    use super::*;

    fn record(version: &str, channel: &str, platform: &str) -> KernelRecord {
        KernelRecord {
            id: "fingerprint-chromium".into(),
            engine: Engine::Chromium,
            version: version.into(),
            platform: platform.into(),
            channel: channel.into(),
            url: String::new(),
            filename: String::new(),
            sha256: "00".into(),
            bytes: 1,
            publisher: String::new(),
            released_at: String::new(),
            upstream: String::new(),
            license: String::new(),
            notes: String::new(),
        }
    }

    #[test]
    fn versions_compare_numerically_not_as_text() {
        assert!(version_key("148.0.7778.215") < version_key("150.0.1.2"));
        assert!(version_key("99.0.0.1") < version_key("148.0.0.0"));
        assert!(version_key("148.0.7778.99") < version_key("148.0.7778.215"));
    }

    #[test]
    fn lists_only_this_platform_newest_first_without_duplicates() {
        let here = this_platform();
        let manifest = ManifestFile {
            channel: "stable".into(),
            kernels: vec![
                record("148.0.7778.215", "stable", here),
                record("150.0.1.2", "candidate", here),
                record("150.0.1.2", "candidate", here),
                record("151.0.0.0", "stable", "some-other-os"),
            ],
        };
        let versions: Vec<String> = kernels_for_this_os(&manifest)
            .into_iter()
            .map(|k| k.version)
            .collect();
        assert_eq!(versions, ["150.0.1.2", "148.0.7778.215"]);
    }

    #[test]
    fn versions_may_carry_a_prerelease_tag_but_never_a_path() {
        for ok in ["148.0.7778.215", "152.0.4-beta.30", "150.0.1.2", "1"] {
            assert!(valid_version(ok), "{ok}");
        }
        // 版本号会拼进本机路径。
        for bad in [
            "",
            "../150",
            "150/..",
            "150..1",
            ".150",
            "150.",
            "-beta",
            "150-",
            "150-beta..1",
            "150-beta/1",
            "150 1",
            "152.0.4-beta.30-x",
            "v152",
        ] {
            assert!(!valid_version(bad), "{bad}");
        }
        assert!(version_key("152.0.4-beta.30") > version_key("152.0.4-beta.29"));
        assert!(version_key("152.0.4-beta.30") > version_key("148.0.7778.215"));
    }

    #[test]
    fn the_bundled_manifest_has_both_engine_classes_for_every_platform() {
        let manifest: ManifestFile =
            serde_json::from_str(include_str!("../../../kernels.manifest.json")).unwrap();
        for platform in ["linux-x64", "win-x64", "mac-arm64"] {
            for engine in Engine::ALL {
                let found = manifest
                    .kernels
                    .iter()
                    .find(|k| k.platform == platform && k.engine == engine)
                    .unwrap_or_else(|| panic!("{platform} 上没有 {engine:?} 类的内核"));
                assert_eq!(found.id, engine.build_id());
                assert!(
                    found.url.starts_with(engine.upstream_prefix()),
                    "{}",
                    found.url
                );
                assert!(valid_version(&found.version));
                assert_eq!(found.sha256.len(), 64);
            }
        }
    }

    #[test]
    fn default_prefers_newest_stable_over_newer_preview() {
        let here = this_platform();
        let list = vec![
            record("150.0.1.2", "candidate", here),
            record("148.0.7778.215", "stable", here),
        ];
        let c = Engine::Chromium;
        assert_eq!(default_version(&list, c).as_deref(), Some("148.0.7778.215"));
        assert_eq!(default_version(&list[..1], c).as_deref(), Some("150.0.1.2"));
        assert_eq!(default_version(&[], c), None);
        // 两类各算各的：Chromium 的版本再新，也不会成为 Firefox 类的默认。
        assert_eq!(default_version(&list, Engine::Firefox), None);
    }
}
