//! 用户在「额外参数」里写的启动参数能不能用。规则只有这一份：启动时用它，工作台的参数页也来问它。

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FlagClass {
    Allow,
    Warn,
    Reject,
}

/// 一个启动参数的判定。工作台的参数页显示的就是这个——规则只有这一份，界面不自己判。
#[derive(Debug, Serialize)]
pub struct Classified {
    pub raw: String,
    pub name: String,
    #[serde(rename = "cls")]
    pub class: FlagClass,
    /// 给用户看的一句话：为什么行、为什么不行。
    pub reason: &'static str,
}

fn flag_name(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('-')
        .split('=')
        .next()
        .unwrap_or("")
        .to_string()
}

fn flag_value(raw: &str) -> &str {
    raw.split_once('=').map(|(_, v)| v).unwrap_or("")
}

/// 这些由环境自己的设置决定，Host 启动时会传。同名开关 Chromium 只认最后一个，
/// 所以在「额外参数」里再写一遍等于悄悄改掉环境的设置：界面上显示的画像、代理、数据目录就和真正跑的不一样了。
/// `--user-data-dir` 指到别的环境去，两个环境就共用了 Cookie。
const OWNED: &[&str] = &[
    "user-data-dir",
    "proxy-server",
    "proxy-bypass-list",
    "remote-debugging-port",
    "remote-allow-origins",
    "fingerprint",
    "fingerprint-platform",
    "fingerprint-platform-version",
    "fingerprint-brand",
    "fingerprint-brand-version",
    "fingerprint-hardware-concurrency",
    "lang",
    "accept-lang",
    "timezone",
    "window-size",
];

/// 会破坏环境之间、网页和本机之间隔离的开关。
const REJECT: &[&str] = &[
    "disable-web-security",
    "disable-site-isolation-trials",
    "disable-features",
    "host-resolver-rules",
];

const WARN: &[&str] = &[
    "disable-setuid-sandbox",
    "disable-dev-shm-usage",
    "load-extension",
    "disable-extensions-except",
    "allow-running-insecure-content",
];

const ALLOW: &[&str] = &[
    "disable-spoofing",
    "disable-non-proxied-udp",
    "remote-debugging-address",
    "headless",
    "disable-gpu",
    "no-first-run",
    "no-default-browser-check",
    "disable-sync",
    "disable-background-networking",
    "metrics-recording-only",
    "mute-audio",
    "hide-scrollbars",
    "font-render-hinting",
    "disable-webrtc",
];

/// 判定用户在「额外参数」里写的一个开关。默认拒绝：名单之外的一律不放行。
pub fn classify(raw: &str) -> Classified {
    let name = flag_name(raw);
    let value = flag_value(raw);
    let n = name.as_str();
    let (class, reason) =
        if n == "remote-debugging-address" && !value.is_empty() && value != "127.0.0.1" {
            (FlagClass::Reject, "调试端口只能绑在 127.0.0.1")
        } else if n == "no-sandbox" || n == "disable-gpu-sandbox" {
            (FlagClass::Warn, "会关掉 Chromium 的沙箱")
        } else if REJECT.contains(&n) {
            (FlagClass::Reject, "会破坏隔离，不允许")
        } else if OWNED.contains(&n) {
            (FlagClass::Reject, "由环境自己的设置决定，到对应的页面去改")
        } else if WARN.contains(&n) {
            (FlagClass::Warn, "有风险，用了会记审计")
        } else if ALLOW.contains(&n) || n.starts_with("fingerprint") {
            (FlagClass::Allow, "在白名单里")
        } else {
            (FlagClass::Reject, "不在白名单里")
        };
    Classified {
        raw: raw.to_string(),
        name,
        class,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class_of(raw: &str) -> FlagClass {
        classify(raw).class
    }

    #[test]
    fn unknown_flags_are_rejected_by_default() {
        assert_eq!(class_of("--totally-made-up"), FlagClass::Reject);
        assert_eq!(class_of("--auto-open-devtools-for-tabs"), FlagClass::Reject);
        assert_eq!(class_of(""), FlagClass::Reject);
    }

    #[test]
    fn debugging_port_cannot_be_moved_off_loopback() {
        assert_eq!(
            class_of("--remote-debugging-address=127.0.0.1"),
            FlagClass::Allow
        );
        assert_eq!(
            class_of("--remote-debugging-address=0.0.0.0"),
            FlagClass::Reject
        );
        assert_eq!(
            class_of("--remote-debugging-address=192.168.1.5"),
            FlagClass::Reject
        );
    }

    #[test]
    fn isolation_breakers_are_rejected() {
        for flag in [
            "--disable-web-security",
            "--disable-site-isolation-trials",
            "--host-resolver-rules=MAP * 10.0.0.1",
            "--disable-features=SomethingImportant",
        ] {
            assert_eq!(class_of(flag), FlagClass::Reject, "{flag} 不该被放行");
        }
    }

    #[test]
    fn sandbox_flags_warn_rather_than_pass_silently() {
        assert_eq!(class_of("--no-sandbox"), FlagClass::Warn);
        assert_eq!(class_of("--disable-gpu-sandbox"), FlagClass::Warn);
        assert_eq!(class_of("--load-extension=/tmp/x"), FlagClass::Warn);
    }

    #[test]
    fn fingerprint_flags_pass() {
        // 这个版本还不认识的指纹开关（跟着上游内核来的）可以试。
        assert_eq!(class_of("--fingerprint-gpu-vendor=x"), FlagClass::Allow);
        assert_eq!(class_of("--disable-spoofing=canvas"), FlagClass::Allow);
    }

    #[test]
    fn settings_the_environment_owns_cannot_be_overridden() {
        // Chromium 只认最后一个同名开关：放行它们，就等于让额外参数悄悄改掉环境的画像、代理和数据目录。
        for flag in [
            "--user-data-dir=/data/profiles/env_other/user-data",
            "--proxy-server=http://10.0.0.1:8080",
            "--remote-debugging-port=9222",
            "--fingerprint=1",
            "--fingerprint-platform=macos",
            "--timezone=Asia/Shanghai",
            "--lang=zh-CN",
            "--accept-lang=zh-CN",
            "--window-size=9999,9999",
        ] {
            let c = classify(flag);
            assert_eq!(c.class, FlagClass::Reject, "{flag}");
            assert!(c.reason.contains("环境自己的设置"), "{flag}: {}", c.reason);
        }
    }

    #[test]
    fn verdicts_serialize_the_way_the_workbench_reads_them() {
        let v = serde_json::to_value(classify("--no-sandbox")).unwrap();
        assert_eq!(v["raw"], "--no-sandbox");
        assert_eq!(v["name"], "no-sandbox");
        assert_eq!(v["cls"], "warn");
        assert!(v["reason"].as_str().unwrap().contains("沙箱"));
    }
}
