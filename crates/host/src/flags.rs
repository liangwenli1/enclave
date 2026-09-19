#[derive(Clone, Copy, PartialEq, Eq)]
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
