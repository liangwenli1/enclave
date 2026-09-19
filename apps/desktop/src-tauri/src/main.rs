#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data)?;
            if let Ok(resource) = app.path().resource_dir() {
                let manifest_src = resource.join("kernels.manifest.json");
                let manifest_dst = data.join("kernels.manifest.json");
                if manifest_src.exists() && !manifest_dst.exists() {
                    let _ = std::fs::copy(&manifest_src, &manifest_dst);
                }
            }
            match app.shell().sidecar("enclave-host") {
                Ok(cmd) => {
                    if let Err(e) = cmd
                        .current_dir(&data)
                        .env("ENCLAVE_ALLOW_LOOPBACK_NO_AUTH", "1")
                        .spawn()
                    {
                        eprintln!("enclave-host spawn: {e}");
                    }
                }
                Err(e) => eprintln!("enclave-host sidecar: {e}"),
            }
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("enclave desktop");
}
