#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Enclave 桌面壳。
//!
//! 它做三件事：生成本机令牌、带着令牌启动 Host、把同一个令牌注入给工作台页面。
//! 工作台和 Host 因此共享一个只存在于这次运行的密钥，**没有"跳过鉴权"的开关**。

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
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data)?;
            seed_manifest(app.handle(), &data);

            let token = new_token();

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

fn seed_manifest(app: &tauri::AppHandle, data: &std::path::Path) {
    let dest = data.join("kernels.manifest.json");
    let mut sources = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        sources.push(dir.join("kernels.manifest.json"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            sources.push(dir.join("kernels.manifest.json"));
            sources.push(dir.join("resources").join("kernels.manifest.json"));
        }
    }
    for src in sources {
        if src.is_file() {
            let _ = std::fs::copy(&src, &dest);
            return;
        }
    }
}
