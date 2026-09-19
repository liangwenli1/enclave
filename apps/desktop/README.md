# apps/desktop

Tauri 2 壳。在 **Windows x64 客户机**上打未签名 MSI。Linux 验证机不编译这个包。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-msi.ps1
```

产物：`apps/desktop/src-tauri/target/release/bundle/msi/`

这是 preview。没有 Authenticode 之前不得称为 1.0。Host 以 sidecar 跑，数据目录在 `%LOCALAPPDATA%\com.enclave.workbench`。
