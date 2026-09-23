//! Firefox 类内核（Camoufox）怎么启动。
//!
//! 和 Chromium 类不一样的地方，都是实测出来的（docs/enclave-final-delivery.md §4.15）：
//! - 指纹不走启动参数，走环境变量 `CAMOU_CONFIG_1..n` 里的一份 JSON；不需要 Playwright。
//! - 屏幕分辨率、显卡字符串能按环境给。缩放不用它自己的 `window.devicePixelRatio`
//!   （只改了 JS 取值，媒体查询对不上），用 Firefox 自带的 `layout.css.devPixelsPerPx`，三处自洽。
//! - 代理写进 profile 的 `user.js`，指向本机的代理桥，域名交给代理解析。
//! - 调试协议是 WebDriver BiDi，不是 CDP。
//! - Canvas 不加噪声：上游 2026-04 把噪声补丁删了（像素噪声本身会被识别）。
//!   `toDataURL()` 每次会话不一样是 Firefox 自己的基线保护，真实用户也一样，这里不去关它。

use crate::kernel::FingerprintProfile;
use serde_json::{json, Map, Value};
use std::path::Path;

/// 这一类环境的身份里，由平台和内核版本决定、不该让人手填的那几项。
pub struct Identity {
    pub user_agent: String,
    pub app_version: &'static str,
    pub oscpu: &'static str,
    pub platform: &'static str,
    /// 字体名单、字体配置目录用的系统名。
    fonts_key: &'static str,
    fontconfig_dir: &'static str,
}

/// "152.0.4-beta.30" → "152.0"。真实 Firefox 的 UA 里 rv 和版本永远是 主版本.0。
fn ua_version(kernel_version: &str) -> String {
    let major: String = kernel_version
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    format!("{major}.0")
}

pub fn identity(platform: &str, kernel_version: &str) -> Identity {
    let v = ua_version(kernel_version);
    // Windows 10 和 11 在 Firefox 的 UA 里都是 "Windows NT 10.0"；macOS 永远报 10.15。
    let (os_token, app_version, oscpu, nav_platform, fonts_key, fontconfig_dir) = match platform {
        "macos" => (
            "Macintosh; Intel Mac OS X 10.15",
            "5.0 (Macintosh)",
            "Intel Mac OS X 10.15",
            "MacIntel",
            "mac",
            "macos",
        ),
        "linux" => (
            "X11; Linux x86_64",
            "5.0 (X11)",
            "Linux x86_64",
            "Linux x86_64",
            "lin",
            "linux",
        ),
        _ => (
            "Windows NT 10.0; Win64; x64",
            "5.0 (Windows)",
            "Windows NT 10.0; Win64; x64",
            "Win32",
            "win",
            "windows",
        ),
    };
    Identity {
        user_agent: format!("Mozilla/5.0 ({os_token}; rv:{v}) Gecko/20100101 Firefox/{v}"),
        app_version,
        oscpu,
        platform: nav_platform,
        fonts_key,
        fontconfig_dir,
    }
}

const FONTS: &str = include_str!("../data/firefox-fonts.json");

fn fonts_for(key: &str) -> Vec<String> {
    serde_json::from_str::<Value>(FONTS)
        .ok()
        .and_then(|v| v.get(key).cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub struct Plan<'a> {
    pub kernel_version: &'a str,
    pub profile: &'a FingerprintProfile,
    /// 实际用的时区和语言（可能已经按出口改过）。
    pub timezone: &'a str,
    pub locale: &'a str,
    pub languages: &'a [String],
    /// 本机代理桥的端口。没配代理就是 None。
    pub bridge_port: Option<u16>,
    /// 出口 IP。WebRTC 报它，而不是本机的。
    pub exit_ip: Option<&'a str>,
    /// 出口所在的经纬度。定位和时区、语言一样跟着出口走——
    /// 代理在柏林、时区是柏林，定位却在别处，是一查就发现的矛盾。
    pub exit_coords: Option<(f64, f64)>,
    /// 用户选了"禁用定位"：网页连问都问不到。
    pub geo_blocked: bool,
}

/// 给 Camoufox 的那份配置。只写会生效、并且彼此成套的键。
pub fn config(plan: &Plan) -> Value {
    let p = plan.profile;
    let id = identity(&p.platform, plan.kernel_version);
    let seed: u32 = p.seed.parse().unwrap_or(1).max(1);
    let (language, region) = match plan.locale.split_once('-') {
        Some((l, r)) => (l, Some(r)),
        None => (plan.locale, None),
    };
    let mut c = Map::new();
    let mut put = |k: &str, v: Value| {
        c.insert(k.to_string(), v);
    };
    put("navigator.userAgent", json!(id.user_agent));
    put("navigator.appVersion", json!(id.app_version));
    put("navigator.oscpu", json!(id.oscpu));
    put("navigator.platform", json!(id.platform));
    put(
        "navigator.hardwareConcurrency",
        json!(p.hardware_concurrency),
    );
    put("navigator.maxTouchPoints", json!(0));
    put("timezone", json!(plan.timezone));
    // 定位跟着出口走。和时区、语言一样写进启动配置，所以对所有标签页都算数。
    if let Some((lat, lon)) = plan.exit_coords {
        put("geolocation:latitude", json!(lat));
        put("geolocation:longitude", json!(lon));
        // 精度给 50 米：真实设备不会给出一个整数。
        put("geolocation:accuracy", json!(50.0));
    }
    put("locale:language", json!(language));
    if let Some(region) = region {
        put("locale:region", json!(region));
    }
    // navigator.languages 和 Accept-Language 都从这一项来。
    put("locale:all", json!(plan.languages.join(", ")));
    if let Some(s) = &p.screen {
        put("screen.width", json!(s.width));
        put("screen.height", json!(s.height));
        put("screen.availWidth", json!(s.avail_width));
        put("screen.availHeight", json!(s.avail_height));
        put("screen.availLeft", json!(0));
        put(
            "screen.availTop",
            json!(s.height.saturating_sub(s.avail_height).min(40)),
        );
        put("screen.colorDepth", json!(s.color_depth));
        put("screen.pixelDepth", json!(s.color_depth));
    }
    // 窗口必须显式给：不给的话默认 1280×1040，会比伪装出来的屏幕还大。
    put("window.outerWidth", json!(p.window.width));
    put("window.outerHeight", json!(p.window.height));
    put("window.screenX", json!(0));
    put("window.screenY", json!(0));
    if let Some(gl) = &p.webgl {
        put("webGl:vendor", json!(gl.vendor));
        put("webGl:renderer", json!(gl.renderer));
    }
    let fonts = fonts_for(id.fonts_key);
    if !fonts.is_empty() {
        put("fonts", json!(fonts));
    }
    // 字体间距和音频的噪声跟着环境的种子走：同一个环境每次启动都一样。
    put("fonts:spacing_seed", json!(seed));
    put("audio:seed", json!(seed ^ 0x5bd1_e995));
    if p.webrtc.mode != "disable" {
        if let Some(ip) = plan
            .exit_ip
            .filter(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())
        {
            put("webrtc:ipv4", json!(ip));
        }
    }
    Value::Object(c)
}

/// 写进 profile 的首选项。每次启动都重写：代理桥的端口每次都不一样。
pub fn user_js(plan: &Plan) -> String {
    let mut prefs: Vec<(&str, Value)> = vec![
        ("browser.shell.checkDefaultBrowser", json!(false)),
        ("browser.aboutwelcome.enabled", json!(false)),
        ("datareporting.policy.dataSubmissionEnabled", json!(false)),
        ("toolkit.telemetry.reportingpolicy.firstRun", json!(false)),
        ("app.update.auto", json!(false)),
    ];
    // 用户选了禁用：把定位功能整个关掉，网页拿到的是"用户拒绝了"。
    if plan.geo_blocked {
        prefs.push(("geo.enabled", json!(false)));
    }
    match plan.bridge_port {
        Some(port) => prefs.extend([
            ("network.proxy.type", json!(1)),
            ("network.proxy.socks", json!("127.0.0.1")),
            ("network.proxy.socks_port", json!(port)),
            ("network.proxy.socks_version", json!(5)),
            // 域名交给代理出口解析，本机不查 DNS。
            ("network.proxy.socks_remote_dns", json!(true)),
            ("network.proxy.no_proxies_on", json!("")),
            ("network.trr.mode", json!(5)),
            ("network.dns.disablePrefetch", json!(true)),
            ("network.http.http3.enable", json!(false)),
        ]),
        None => prefs.push(("network.proxy.type", json!(0))),
    }
    if plan.profile.webrtc.mode == "disable" {
        prefs.push(("media.peerconnection.enabled", json!(false)));
    }
    // 缩放用 Firefox 自己的机制：devicePixelRatio、媒体查询、screen 三处一起变（实测自洽）。
    // 代价是页面真的按这个比例显示，所以工作台只给出这台显示器上用得了的值。
    if let Some(dpr) = plan
        .profile
        .device_pixel_ratio
        .filter(|d| (0.5..=4.0).contains(d))
    {
        prefs.push(("layout.css.devPixelsPerPx", json!(format!("{dpr}"))));
    }
    let mut out = String::from("// 由 Enclave 在每次启动前生成，手改会被覆盖。\n");
    for (k, v) in prefs {
        out.push_str(&format!("user_pref({}, {});\n", json!(k), v));
    }
    out
}

/// JSON 里的非 ASCII 字符写成 \uXXXX：这样按字节切段和按字符切段是一回事，
/// Windows 上环境变量是 UTF-16，也不会因为编码不同对不上长度。
fn ascii_json(value: &Value) -> String {
    let raw = value.to_string();
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii() {
            out.push(ch);
        } else {
            let mut buf = [0u16; 2];
            for unit in ch.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

/// 配置切成 `CAMOU_CONFIG_1..n`。Windows 上单个环境变量最多 2047 个字符，其余系统 32767。
pub fn env_chunks(config: &Value, windows: bool) -> Vec<(String, String)> {
    let text = ascii_json(config);
    let size = if windows { 2047 } else { 32767 };
    text.as_bytes()
        .chunks(size)
        .enumerate()
        .map(|(i, part)| {
            (
                format!("CAMOU_CONFIG_{}", i + 1),
                String::from_utf8_lossy(part).into_owned(),
            )
        })
        .collect()
}

/// Linux 上要告诉 fontconfig 去用包里那套目标系统的字体配置，否则 Windows 画像渲染出来的还是本机字体。
pub fn fontconfig_path(exe: &Path, platform: &str) -> Option<std::path::PathBuf> {
    let dir = exe
        .parent()?
        .join("fontconfig")
        .join(identity(platform, "0").fontconfig_dir);
    dir.join("fonts.conf").is_file().then_some(dir)
}

pub fn args(
    profile_dir: &Path,
    debug_port: u16,
    window: (u32, u32),
    headless: bool,
) -> Vec<String> {
    let mut args = vec![
        "-profile".to_string(),
        profile_dir.display().to_string(),
        // 不去找"已经在跑的那个 Firefox"：每个环境是各自独立的一个进程。
        "-no-remote".to_string(),
        format!("--remote-debugging-port={debug_port}"),
        "-width".to_string(),
        window.0.to_string(),
        "-height".to_string(),
        window.1.to_string(),
    ];
    if headless {
        args.push("-headless".into());
    }
    // Windows 上 firefox.exe 默认是个启动器：拉起真正的浏览器进程后自己就退了，
    // Host 会以为浏览器已经关了。这个参数让它等到浏览器退出（Playwright 也是这么起的）。
    if cfg!(windows) {
        args.push("-wait-for-browser".into());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(platform: &str) -> FingerprintProfile {
        serde_json::from_value(json!({
            "seed": "12345", "platform": platform, "platformVersion": "19.0.0", "brand": "Firefox",
            "brandVersion": "152.0.4-beta.30", "hardwareConcurrency": 8, "locale": "ja",
            "languages": ["ja", "en-US", "en"], "timezone": "Asia/Tokyo",
            "window": {"width": 1536, "height": 864},
            "screen": {"width": 1920, "height": 1080, "availWidth": 1920, "availHeight": 1032, "colorDepth": 24},
            "devicePixelRatio": 1.25,
            "webgl": {"vendor": "Google Inc. (Intel)", "renderer": "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar"},
            "webrtc": {"mode": "replace"}
        }))
        .unwrap()
    }

    /// 定位要和时区、语言一样写进启动配置：这样对所有标签页都算数，
    /// 不像启动之后补一刀那样只覆盖第一个。
    #[test]
    fn the_exit_coordinates_go_into_the_launch_config() {
        let p = profile("windows");
        let langs = vec!["de-DE".to_string()];
        let mut pl = plan(&p, &langs);
        pl.exit_coords = Some((52.52, 13.405));
        let c = config(&pl);
        assert_eq!(c["geolocation:latitude"], 52.52);
        assert_eq!(c["geolocation:longitude"], 13.405);
        assert!(c["geolocation:accuracy"].as_f64().is_some(), "精度要给一个");

        // 没有代理就没有出口，也就没有坐标：这时一个字都不写，用真实位置，不编一个。
        pl.exit_coords = None;
        let c = config(&pl);
        assert!(c.get("geolocation:latitude").is_none());
        assert!(c.get("geolocation:accuracy").is_none());
    }

    /// 选了"禁用"就要把定位功能整个关掉——不是"不覆盖"，是网页根本要不到。
    #[test]
    fn blocking_turns_the_feature_off_entirely() {
        let p = profile("windows");
        let langs = vec!["en-US".to_string()];
        let mut pl = plan(&p, &langs);
        assert!(!user_js(&pl).contains("geo.enabled"), "默认不动这一项");
        pl.geo_blocked = true;
        assert!(
            user_js(&pl).contains(r#"user_pref("geo.enabled", false)"#),
            "禁用时要写进 user.js：启动前生效，对所有标签页都算数"
        );
    }

    fn plan<'a>(p: &'a FingerprintProfile, langs: &'a [String]) -> Plan<'a> {
        Plan {
            kernel_version: "152.0.4-beta.30",
            profile: p,
            timezone: "Asia/Tokyo",
            locale: "ja",
            languages: langs,
            bridge_port: Some(41000),
            exit_ip: Some("133.1.2.3"),
            exit_coords: None,
            geo_blocked: false,
        }
    }

    #[test]
    fn user_agent_always_matches_the_kernel_it_runs_on() {
        let win = identity("windows", "152.0.4-beta.30");
        assert_eq!(
            win.user_agent,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0"
        );
        assert_eq!((win.platform, win.app_version), ("Win32", "5.0 (Windows)"));
        let mac = identity("macos", "160.0.1");
        assert!(
            mac.user_agent.contains("Intel Mac OS X 10.15; rv:160.0")
                && mac.user_agent.ends_with("Firefox/160.0")
        );
        assert_eq!(mac.platform, "MacIntel");
        assert_eq!(identity("linux", "152.0").oscpu, "Linux x86_64");
        // 不给配置时 Camoufox 的 UA 里带着自己的名字，所以这一项永远要给。
        assert!(!win.user_agent.contains("Camoufox"));
    }

    #[test]
    fn config_is_a_matched_set_and_leaves_out_keys_that_do_nothing() {
        let p = profile("windows");
        let langs = p.languages.clone();
        let c = config(&plan(&p, &langs));
        assert_eq!(c["navigator.platform"], "Win32");
        assert_eq!(c["navigator.hardwareConcurrency"], 8);
        assert_eq!(c["locale:language"], "ja");
        assert!(c.get("locale:region").is_none());
        assert_eq!(c["locale:all"], "ja, en-US, en");
        assert_eq!(c["timezone"], "Asia/Tokyo");
        assert_eq!(
            (c["screen.width"].as_u64(), c["screen.availHeight"].as_u64()),
            (Some(1920), Some(1032))
        );
        assert_eq!(
            (
                c["window.outerWidth"].as_u64(),
                c["window.outerHeight"].as_u64()
            ),
            (Some(1536), Some(864))
        );
        assert_eq!(c["webGl:vendor"], "Google Inc. (Intel)");
        assert_eq!(c["webrtc:ipv4"], "133.1.2.3");
        assert!(c["fonts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "Segoe UI"));
        assert_eq!(c["fonts:spacing_seed"], 12345);
        // 实测不生效或者自相矛盾的键不写：Canvas 种子上游已经删了；缩放走 Firefox 自己的首选项。
        for dead in [
            "canvas:seed",
            "window.devicePixelRatio",
            "navigator.language",
            "headers.Accept-Language",
        ] {
            assert!(c.get(dead).is_none(), "{dead}");
        }
        let de = config(&Plan {
            locale: "de-DE",
            ..plan(&p, &langs)
        });
        assert_eq!(
            (de["locale:language"].as_str(), de["locale:region"].as_str()),
            (Some("de"), Some("DE"))
        );
    }

    #[test]
    fn prefs_send_everything_through_the_bridge_and_scale_coherently() {
        let p = profile("windows");
        let langs = p.languages.clone();
        let js = user_js(&plan(&p, &langs));
        assert!(
            js.contains(r#"user_pref("network.proxy.socks_port", 41000);"#),
            "{js}"
        );
        assert!(js.contains(r#"user_pref("network.proxy.socks_remote_dns", true);"#));
        assert!(js.contains(r#"user_pref("layout.css.devPixelsPerPx", "1.25");"#));
        assert!(!js.contains("media.peerconnection.enabled"));
        let direct = user_js(&Plan {
            bridge_port: None,
            ..plan(&p, &langs)
        });
        assert!(
            direct.contains(r#"user_pref("network.proxy.type", 0);"#)
                && !direct.contains("socks_port")
        );
    }

    #[test]
    fn config_is_cut_into_env_vars_that_fit_each_system() {
        let p = profile("macos");
        let langs = p.languages.clone();
        let c = config(&plan(&p, &langs));
        let win = env_chunks(&c, true);
        assert!(win.len() > 1, "mac 的字体名单很长，Windows 上一定要切段");
        assert!(win.iter().all(|(_, v)| v.len() <= 2047 && v.is_ascii()));
        assert_eq!(win[0].0, "CAMOU_CONFIG_1");
        let joined: String = win.iter().map(|(_, v)| v.as_str()).collect();
        assert_eq!(serde_json::from_str::<Value>(&joined).unwrap(), c);
        assert_eq!(env_chunks(&c, false).len(), 1);
    }
}
