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
  document.body.classList.add("www");
  const header = document.createElement("header");
  header.className = "www-header";
  const current = here();
  header.innerHTML = `<div class="www-bar">
    <a class="www-brand" href="index.html"><span class="www-mark"><i></i></span>Enclave</a>
    <nav class="www-nav">${NAV.map(
      ([href, label]) =>
        `<a href="${href}" data-active="${current === href ? "true" : "false"}">${label}</a>`,
    ).join("")}</nav>
  </div>`;
  const footer = document.createElement("footer");
  footer.className = "www-footer";
  footer.innerHTML = `<div class="www-foot">
    <div>内核 BSD-3-Clause · fingerprint-chromium · <a href="legal.html">安全与法律</a></div>
    <div>安装包不收费。功能靠账号额度解锁。</div>
  </div>`;
  document.body.prepend(header);
  document.body.append(footer);
}

const KEY = "enclave.site.account";
const account = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  },
  write(v) {
    localStorage.setItem(KEY, JSON.stringify(v));
  },
  clear() {
    localStorage.removeItem(KEY);
  },
};

document.addEventListener("DOMContentLoaded", injectChrome);
