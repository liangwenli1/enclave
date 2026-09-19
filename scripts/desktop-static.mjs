import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const files = walk(path.join(root, "dist"));
const index = files.find((f) => f.endsWith(`${path.sep}index.html`) || f.endsWith("/index.html"));
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

if (index) {
  const srcDir = path.dirname(index);
  copyDir(srcDir, dest);
} else {
  const client = path.join(root, "dist", "client");
  if (existsSync(client)) copyDir(client, dest);
  const assets = existsSync(path.join(dest, "assets"))
    ? readdirSync(path.join(dest, "assets"))
    : existsSync(path.join(root, "dist", "client", "assets"))
      ? readdirSync(path.join(root, "dist", "client", "assets"))
      : [];
  const js = assets.find((n) => n.startsWith("index-") && n.endsWith(".js"));
  const css = assets.find((n) => n.startsWith("styles-") && n.endsWith(".css"));
  if (!js) {
    console.error("desktop-static: no index.html and no assets/index-*.js");
    console.error(files.slice(0, 40).join("\n"));
    process.exit(1);
  }
  if (existsSync(client) && !existsSync(path.join(dest, "assets"))) copyDir(client, dest);
  writeFileSync(
    path.join(dest, "index.html"),
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Enclave</title>
    ${css ? `<link rel="stylesheet" href="./assets/${css}" />` : ""}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./assets/${js}"></script>
  </body>
</html>
`,
  );
}

if (!existsSync(path.join(dest, "index.html"))) {
  console.error("desktop-static: still no index.html");
  process.exit(1);
}
console.log("desktop-static:", dest);
