const NAV = [
  ["index.html", "产品"],
  ["pricing.html", "套餐"],
  ["download.html", "下载"],
  ["docs.html", "文档"],
  ["account.html", "账号"],
];

function here() {
  const p = location.pathname.split("/").pop() || "index.html";
  return p === "" ? "index.html" : p;
}

function injectChrome() {
  const header = document.createElement("header");
  header.innerHTML = `<div class="bar">
    <a class="brand" href="index.html"><span class="mark"><i></i></span>Enclave</a>
    <nav>${NAV.map(([href, label]) => `<a href="${href}" class="${here() === href ? "on" : ""}">${label}</a>`).join("")}</nav>
  </div>`;
  const footer = document.createElement("footer");
  footer.innerHTML = `<div class="foot">
    <div>内核 BSD-3-Clause · Ungoogled Chromium · fingerprint-chromium · <a href="legal.html">安全与法律</a></div>
    <div>安装包不收费。功能靠账号额度解锁。不宣传过某站风控。</div>
  </div>`;
  document.body.prepend(header);
  document.body.append(footer);
}

const KEY = "enclave.site.account";
const account = {
  read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  },
  write(v) { localStorage.setItem(KEY, JSON.stringify(v)); },
  clear() { localStorage.removeItem(KEY); },
};

document.addEventListener("DOMContentLoaded", injectChrome);
