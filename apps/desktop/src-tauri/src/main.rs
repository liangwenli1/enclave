#![cfg_attr(all(not(debug_assertions), not(feature = "devtools")), windows_subsystem = "windows")]

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
            for window in app.webview_windows() {
                window.open_devtools();
                let probe = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = probe.eval(
                        r#"(function(){
                          var n=document.getElementById('root');
                          var t=n?(n.innerText||''):'';
                          if(!n||/Loading Enclave/.test(t)||!t.trim()){
                            document.body.style.cssText='margin:24px;background:#111;color:#c8f31d;font:16px sans-serif;white-space:pre-wrap';
                            document.body.textContent='href='+location.href+'\nroot='+t;
                          }
                        })()"#,
                    );
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("enclave desktop");
}
