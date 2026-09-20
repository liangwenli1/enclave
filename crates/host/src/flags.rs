#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagClass {
    Allow,
    Warn,
    Reject,
}

pub struct Classified {
    pub raw: String,
    pub class: FlagClass,
}

fn flag_name(raw: &str) -> String {
    raw.trim().trim_start_matches('-').split('=').next().unwrap_or("").to_string()
}

fn flag_value(raw: &str) -> &str {
    raw.split_once('=').map(|(_, v)| v).unwrap_or("")
}

pub fn classify(raw: &str) -> Classified {
    let name = flag_name(raw);
    let value = flag_value(raw);
    if name == "remote-debugging-address" && !value.is_empty() && value != "127.0.0.1" {
        return Classified { raw: raw.to_string(), class: FlagClass::Reject };
    }
    if name == "no-sandbox" || name == "disable-gpu-sandbox" {
        return Classified { raw: raw.to_string(), class: FlagClass::Warn };
    }
    const REJECT: &[&str] = &[
        "disable-web-security",
        "disable-site-isolation-trials",
        "disable-features",
        "host-resolver-rules",
    ];
    if REJECT.contains(&name.as_str()) {
        return Classified { raw: raw.to_string(), class: FlagClass::Reject };
    }
    const WARN: &[&str] = &[
        "disable-setuid-sandbox",
        "disable-dev-shm-usage",
        "load-extension",
        "disable-extensions-except",
        "allow-running-insecure-content",
    ];
    if WARN.contains(&name.as_str()) {
        return Classified { raw: raw.to_string(), class: FlagClass::Warn };
    }
    const ALLOW: &[&str] = &[
        "user-data-dir",
        "proxy-server",
        "proxy-bypass-list",
        "fingerprint",
        "fingerprint-platform",
        "fingerprint-platform-version",
        "fingerprint-brand",
        "fingerprint-brand-version",
        "fingerprint-hardware-concurrency",
        "disable-spoofing",
        "disable-non-proxied-udp",
        "remote-debugging-port",
        "remote-debugging-address",
        "remote-allow-origins",
        "lang",
        "accept-lang",
        "timezone",
        "window-size",
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
    if ALLOW.contains(&name.as_str()) || name.starts_with("fingerprint") {
        return Classified { raw: raw.to_string(), class: FlagClass::Allow };
    }
    Classified { raw: raw.to_string(), class: FlagClass::Reject }
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
        assert_eq!(class_of("--remote-debugging-address=127.0.0.1"), FlagClass::Allow);
        assert_eq!(class_of("--remote-debugging-address=0.0.0.0"), FlagClass::Reject);
        assert_eq!(class_of("--remote-debugging-address=192.168.1.5"), FlagClass::Reject);
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
        assert_eq!(class_of("--fingerprint=12345"), FlagClass::Allow);
        assert_eq!(class_of("--fingerprint-platform=windows"), FlagClass::Allow);
        assert_eq!(class_of("--timezone=Asia/Shanghai"), FlagClass::Allow);
    }
}
