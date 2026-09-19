#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data)?;
            seed_manifest(app.handle(), &data);
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
