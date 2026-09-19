import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dest = path.join(root, "apps", "desktop", "src-tauri", "frontend");

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function copyDir(src, out) {
  mkdirSync(out, { recursive: true });
  for (const file of walk(src)) {
    const rel = path.relative(src, file);
    const target = path.join(out, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const client = path.join(root, "dist", "client");
if (!existsSync(client)) {
  console.error("desktop-static: dist/client missing");
  process.exit(1);
}
copyDir(client, dest);
const pub = path.join(root, "public");
if (existsSync(pub)) copyDir(pub, dest);

const assetsDir = path.join(dest, "assets");
const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
const js = assets.find((n) => n.startsWith("index-") && n.endsWith(".js"));
const css = assets.find((n) => n.startsWith("styles-") && n.endsWith(".css"));
if (!js) {
  console.error("desktop-static: no assets/index-*.js");
  process.exit(1);
}

writeFileSync(
  path.join(dest, "index.html"),
  `<!doctype html>
<html lang="zh-CN" style="height:100%">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Enclave</title>
    ${css ? `<link rel="stylesheet" href="./assets/${css}" />` : ""}
    <style>html,body,#root{height:100%;margin:0}</style>
  </head>
  <body style="margin:0;height:100%;background:#c8f31d;color:#111;font:16px/1.4 ui-sans-serif,system-ui">
    <div id="root" style="min-height:100%">Loading Enclave…</div>
    <script>
      window.addEventListener("error", function (e) {
        var n = document.getElementById("root");
        if (n) n.textContent = String((e && e.message) || e);
      });
      window.addEventListener("unhandledrejection", function (e) {
        var n = document.getElementById("root");
        if (n) n.textContent = String(e.reason || e);
      });
      setTimeout(function () {
        var n = document.getElementById("root");
        if (n && /Loading Enclave/.test(n.textContent || "")) {
          n.textContent = "UI bundle did not start. Open DevTools (F12) and send the red error.";
        }
      }, 5000);
    </script>
    <script type="module" src="./assets/${js}"></script>
  </body>
</html>
`,
);
console.log("desktop-static:", dest, "js=", js);
