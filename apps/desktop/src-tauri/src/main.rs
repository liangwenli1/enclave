#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Enclave 桌面壳。
//!
//! 它做三件事：生成本机令牌、带着令牌启动 Host、把同一个令牌注入给工作台页面。
//! 工作台和 Host 因此共享一个只存在于这次运行的密钥，**没有"跳过鉴权"的开关**。
//!
//! 令牌每次启动都换，所以同一时刻只能有一个壳、一个 Host：
//! 第二次双击只是把已有窗口拉到前面；上次崩溃留下的 Host 在启动新的之前清掉。

use rand::RngCore;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::ShellExt;

const HOST_PORT: u16 = 17891;

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    tauri::Builder::default()
        // 必须第一个注册，才能赶在其他初始化之前拦下第二个实例。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data)?;
            seed_manifest(app.handle(), &data);

            let token = new_token();
            kill_orphan_host();

            match app.shell().sidecar("enclave-host") {
                Ok(cmd) => {
                    if let Err(e) = cmd
                        .current_dir(&data)
                        .env("ENCLAVE_HOST_TOKEN", &token)
                        .env("ENCLAVE_HOST_PORT", HOST_PORT.to_string())
                        .spawn()
                    {
                        eprintln!("enclave-host spawn: {e}");
                    }
                }
                Err(e) => eprintln!("enclave-host sidecar: {e}"),
            }

            // 工作台从这个全局变量拿令牌。脚本在页面任何代码之前执行。
            let bootstrap = format!(
                "window.__ENCLAVE_HOST__ = Object.freeze({{ token: \"{token}\", port: {HOST_PORT} }});"
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Enclave")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .initialization_script(&bootstrap)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("enclave desktop");
}

/// 壳被强杀或崩溃时 Host 不会跟着退，它会继续占着端口、拿着旧令牌，
/// 新 Host 绑不上端口，页面拿着新令牌一律 401，重启多少次都一样。
/// 走到这里时已经确认自己是唯一的壳，所以还活着的 enclave-host 一定是孤儿。
fn kill_orphan_host() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "enclave-host.exe", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

/// 把安装包里的内核清单放到 Host 的工作目录。每次启动都覆盖：清单跟着版本走。
fn seed_manifest(app: &tauri::AppHandle, data: &std::path::Path) {
    let Ok(dir) = app.path().resource_dir() else { return };
    let src = dir.join("kernels.manifest.json");
    if let Err(e) = std::fs::copy(&src, data.join("kernels.manifest.json")) {
        eprintln!("seed manifest from {}: {e}", src.display());
    }
}
