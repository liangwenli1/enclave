//! 本地代理桥。
//!
//! Chromium 不接受写在 `--proxy-server` 里的账号密码，也不支持 SOCKS5 认证：
//! 带凭据的地址它直接判为无效，请求根本不会发出去（实测过）。所以每个带代理的环境
//! 在回环地址上有一个只属于它的 SOCKS5 入口，浏览器连这个入口，认证由这里替它向上游完成。
//!
//! 顺带得到三样东西：
//!   - 域名原样交给上游解析，本机不做 DNS 查询，不会因为 DNS 暴露真实位置；
//!   - 启动前先经这条路探一次：上游不通、账号不对，当场说清楚，而不是开出一个打不开网页的窗口；
//!   - 探测拿到出口 IP 和它所在的时区，时区可以跟着出口走。
//!
//! 入口只监听 127.0.0.1、不设认证（浏览器不会 SOCKS 认证）。它只讲 SOCKS5，
//! 网页里的脚本发不出 SOCKS 握手，碰不到它。

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
    Socks5,
}

/// 用户填的那个上游代理。
#[derive(Clone, Debug)]
pub struct Upstream {
    pub scheme: Scheme,
    pub host: String,
    pub port: u16,
    pub auth: Option<(String, String)>,
}

impl Upstream {
    /// `protocol://[user:pass@]host:port`，账号密码是百分号编码过的。
    pub fn parse(url: &str) -> Result<Self> {
        let u = reqwest::Url::parse(url).context("代理地址不是合法的 URL")?;
        let scheme = match u.scheme() {
            "http" => Scheme::Http,
            "https" => Scheme::Https,
            "socks5" | "socks5h" => Scheme::Socks5,
            other => bail!("不支持的代理协议 {other}"),
        };
        let host = u.host_str().context("代理地址里没有主机")?.to_string();
        let port = u.port_or_known_default().context("代理地址里没有端口")?;
        let decode = |s: &str| {
            percent_encoding::percent_decode_str(s)
                .decode_utf8_lossy()
                .into_owned()
        };
        let auth = (!u.username().is_empty())
            .then(|| (decode(u.username()), decode(u.password().unwrap_or(""))));
        Ok(Self {
            scheme,
            host: host.trim_matches(|c| c == '[' || c == ']').to_string(),
            port,
            auth,
        })
    }
}

/// 连上游失败的原因。code 就是启动失败时给用户看的原因码。
#[derive(Clone, Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn unreachable(detail: impl std::fmt::Display) -> Self {
        Self {
            code: "PROXY_UNREACHABLE",
            message: format!("连不上代理服务器，检查地址和端口，或者换一条。（{detail}）"),
        }
    }
    fn auth(detail: impl std::fmt::Display) -> Self {
        Self {
            code: "PROXY_AUTH_FAILED",
            message: format!("代理不认这个账号密码，到代理页重新填。（{detail}）"),
        }
    }
    fn refused(detail: impl std::fmt::Display) -> Self {
        Self {
            code: "PROXY_REFUSED",
            message: format!("代理服务器拒绝了连接。（{detail}）"),
        }
    }
}

/// 浏览器要去的地方。域名不在本机解析，原样交给上游。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Host {
    Domain(String),
    Ip(IpAddr),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    host: Host,
    port: u16,
}

impl Target {
    fn authority(&self) -> String {
        match &self.host {
            Host::Domain(d) => format!("{d}:{}", self.port),
            Host::Ip(IpAddr::V4(ip)) => format!("{ip}:{}", self.port),
            Host::Ip(IpAddr::V6(ip)) => format!("[{ip}]:{}", self.port),
        }
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// 一个环境的代理入口。丢掉它，入口和经过它的所有连接一起关掉。
pub struct Bridge {
    pub port: u16,
    failure: Arc<Mutex<Option<Failure>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Bridge {
    pub async fn start(upstream: Upstream) -> Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let failure = Arc::new(Mutex::new(None));
        let task = tokio::spawn(serve(listener, upstream, failure.clone()));
        Ok(Self {
            port,
            failure,
            task,
        })
    }

    /// 最近一次连上游失败的原因。探测失败时靠它区分"代理不通"和"只是查 IP 的服务不通"。
    pub async fn last_failure(&self) -> Option<Failure> {
        self.failure.lock().await.clone()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(listener: TcpListener, upstream: Upstream, failure: Arc<Mutex<Option<Failure>>>) {
    // 连接都挂在这个集合上：入口任务被中止时集合跟着销毁，连接一起断，不会留下没人管的转发。
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                if let Ok((client, _)) = accepted {
                    conns.spawn(relay(client, upstream.clone(), failure.clone()));
                }
            }
            Some(_) = conns.join_next() => {}
        }
    }
}

async fn relay(mut client: TcpStream, upstream: Upstream, failure: Arc<Mutex<Option<Failure>>>) {
    let Ok(Ok(target)) = timeout(HANDSHAKE_TIMEOUT, accept_socks5(&mut client)).await else {
        return;
    };
    let connected = timeout(HANDSHAKE_TIMEOUT, connect_upstream(&upstream, &target)).await;
    let mut remote = match connected {
        Ok(Ok(stream)) => stream,
        Ok(Err(f)) => {
            *failure.lock().await = Some(f);
            let _ = client.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return;
        }
        Err(_) => {
            *failure.lock().await = Some(Failure::unreachable("超时"));
            let _ = client.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return;
        }
    };
    if client
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .is_err()
    {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut remote).await;
}

/// 浏览器这一侧：SOCKS5，无认证，只接受 CONNECT。
async fn accept_socks5(client: &mut TcpStream) -> Result<Target> {
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await?;
    if head[0] != 5 {
        bail!("不是 SOCKS5");
    }
    let mut methods = vec![0u8; head[1] as usize];
    client.read_exact(&mut methods).await?;
    client.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    client.read_exact(&mut req).await?;
    if req[1] != 1 {
        // 只做 TCP。UDP 关联一律拒绝：没有经过代理的 UDP 就是泄漏。
        client.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        bail!("只支持 CONNECT");
    }
    let host = match req[3] {
        1 => {
            let mut b = [0u8; 4];
            client.read_exact(&mut b).await?;
            Host::Ip(IpAddr::V4(Ipv4Addr::from(b)))
        }
        3 => {
            let len = client.read_u8().await? as usize;
            let mut b = vec![0u8; len];
            client.read_exact(&mut b).await?;
            Host::Domain(String::from_utf8(b).context("域名不是 UTF-8")?)
        }
        4 => {
            let mut b = [0u8; 16];
            client.read_exact(&mut b).await?;
            Host::Ip(IpAddr::V6(Ipv6Addr::from(b)))
        }
        _ => bail!("不认识的地址类型"),
    };
    let port = client.read_u16().await?;
    Ok(Target { host, port })
}

async fn connect_upstream(
    up: &Upstream,
    target: &Target,
) -> std::result::Result<Box<dyn Stream>, Failure> {
    let tcp = match timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((up.host.as_str(), up.port)),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(Failure::unreachable(e)),
        Err(_) => return Err(Failure::unreachable("超时")),
    };
    let _ = tcp.set_nodelay(true);
    match up.scheme {
        Scheme::Http => {
            let mut s = tcp;
            http_connect(&mut s, target, up.auth.as_ref()).await?;
            Ok(Box::new(s))
        }
        Scheme::Https => {
            let mut s = tls(tcp, &up.host).await?;
            http_connect(&mut s, target, up.auth.as_ref()).await?;
            Ok(Box::new(s))
        }
        Scheme::Socks5 => Ok(Box::new(
            socks5_connect(tcp, target, up.auth.as_ref()).await?,
        )),
    }
}

async fn tls(
    tcp: TcpStream,
    host: &str,
) -> std::result::Result<tokio_rustls::client::TlsStream<TcpStream>, Failure> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(Failure::unreachable)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| Failure::unreachable("HTTPS 代理的主机名不合法"))?;
    tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|e| Failure::unreachable(format!("TLS 握手失败：{e}")))
}

/// 上游是 HTTP(S) 代理：发 CONNECT，带上 Basic 认证。
async fn http_connect<S: Stream>(
    s: &mut S,
    target: &Target,
    auth: Option<&(String, String)>,
) -> std::result::Result<(), Failure> {
    let authority = target.authority();
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some((user, pass)) = auth {
        let token = STANDARD.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(Failure::unreachable)?;

    // 一个字节一个字节读到空行为止：空行之后的字节已经属于隧道，不能多读。
    let mut head = Vec::with_capacity(256);
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 {
            return Err(Failure::refused("代理的应答头太长"));
        }
        head.push(s.read_u8().await.map_err(Failure::unreachable)?);
    }
    let line = String::from_utf8_lossy(&head);
    let line = line.lines().next().unwrap_or("").to_string();
    match line.split_whitespace().nth(1) {
        Some(code) if code.starts_with('2') => Ok(()),
        Some("407") => Err(Failure::auth(line)),
        _ => Err(Failure::refused(line)),
    }
}

/// 上游是 SOCKS5：用户名密码认证交给 tokio-socks，目标域名原样交给上游解析。
async fn socks5_connect(
    tcp: TcpStream,
    target: &Target,
    auth: Option<&(String, String)>,
) -> std::result::Result<TcpStream, Failure> {
    use tokio_socks::tcp::Socks5Stream;
    use tokio_socks::{Error as E, TargetAddr};
    let addr = match &target.host {
        Host::Domain(d) => TargetAddr::Domain(d.as_str().into(), target.port),
        Host::Ip(ip) => TargetAddr::Ip(std::net::SocketAddr::new(*ip, target.port)),
    };
    let connected = match auth {
        Some((user, pass)) => {
            Socks5Stream::connect_with_password_and_socket(tcp, addr, user, pass).await
        }
        None => Socks5Stream::connect_with_socket(tcp, addr).await,
    };
    match connected {
        Ok(stream) => Ok(stream.into_inner()),
        Err(
            e @ (E::PasswordAuthFailure(_)
            | E::NoAcceptableAuthMethods
            | E::UnknownAuthMethod
            | E::InvalidAuthValues(_)),
        ) => Err(Failure::auth(e)),
        Err(E::Io(e)) => Err(Failure::unreachable(e)),
        Err(e) => Err(Failure::refused(e)),
    }
}

/* ── 出口探测 ─────────────────────────────────────────────────────────── */

/// 经代理出去之后，外面看到的是谁、在哪。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub ip: String,
    pub country: Option<String>,
    pub city: Option<String>,
    pub timezone: Option<String>,
    /// 出口所在的大致经纬度。代理在柏林、时区是柏林、语言是德语，
    /// 定位却问不出来或者是本机位置——这是风控一查就发现的矛盾。
    pub coords: Option<(f64, f64)>,
}

/// 查"我的出口 IP"的公开服务，按顺序试。请求是经用户的代理发出去的，对方看到的是出口 IP。
/// 都是尽力而为：哪个都不通也不拦启动，只是不自动对齐时区。
/// 可以用环境变量 ENCLAVE_IP_ECHO（逗号分隔）换成自己的服务。
const DEFAULT_ECHO: &[&str] = &[
    "https://ipinfo.io/json",
    "https://ipapi.co/json/",
    "http://ip-api.com/json/?fields=status,countryCode,city,timezone,query,lat,lon",
];

pub async fn probe(bridge_port: u16) -> Result<ExitInfo> {
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!(
            "socks5h://127.0.0.1:{bridge_port}"
        ))?)
        .user_agent("Mozilla/5.0")
        .timeout(Duration::from_secs(12))
        .build()?;
    let custom = std::env::var("ENCLAVE_IP_ECHO").unwrap_or_default();
    let endpoints: Vec<&str> = if custom.trim().is_empty() {
        DEFAULT_ECHO.to_vec()
    } else {
        custom
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut last = anyhow::anyhow!("没有可用的出口查询服务");
    for url in endpoints {
        match client.get(url).send().await {
            Ok(res) => match res.json::<serde_json::Value>().await {
                Ok(body) => match parse_exit(&body) {
                    Some(info) => return Ok(info),
                    None => last = anyhow::anyhow!("{url} 的应答里没有 IP"),
                },
                Err(e) => last = e.into(),
            },
            Err(e) => last = e.into(),
        }
    }
    Err(last)
}

/// 几家服务的字段名不一样，都认。时区必须长得像 IANA 名字才用，否则宁可不对齐。
fn parse_exit(body: &serde_json::Value) -> Option<ExitInfo> {
    let text = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| body.get(k).and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    let ip = text(&["ip", "query"])?;
    ip.parse::<IpAddr>().ok()?;
    let timezone = text(&["timezone"]).filter(|tz| {
        tz.contains('/')
            && tz.len() <= 64
            && tz
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+'))
    });
    // 三家给经纬度的写法不一样：ipinfo 是 "37.38,-122.08" 一个字符串，另两家是两个数。
    let num = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| body.get(k).and_then(|v| v.as_f64()))
    };
    let coords = match (num(&["latitude", "lat"]), num(&["longitude", "lon"])) {
        (Some(lat), Some(lon)) => Some((lat, lon)),
        _ => body.get("loc").and_then(|v| v.as_str()).and_then(|s| {
            let (a, b) = s.split_once(',')?;
            Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
        }),
    }
    .filter(|(lat, lon)| (-90.0..=90.0).contains(lat) && (-180.0..=180.0).contains(lon));

    Some(ExitInfo {
        ip,
        // 几家服务给的都是两位国家代码。不是这个形状的（比如国家全名）不要：按它查不了地区表。
        country: text(&["country_code", "countryCode", "country"])
            .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()))
            .map(|c| c.to_ascii_uppercase()),
        city: text(&["city"]),
        timezone,
        coords,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proxy_urls_with_encoded_credentials() {
        let up = Upstream::parse("http://user%40corp:p%3Ass%2Fword@gate.example.com:7777").unwrap();
        assert_eq!(up.scheme, Scheme::Http);
        assert_eq!((up.host.as_str(), up.port), ("gate.example.com", 7777));
        assert_eq!(up.auth, Some(("user@corp".into(), "p:ss/word".into())));

        let up = Upstream::parse("socks5://10.0.0.8:1080").unwrap();
        assert_eq!(up.scheme, Scheme::Socks5);
        assert_eq!(up.auth, None);

        assert_eq!(Upstream::parse("https://p.example.com").unwrap().port, 443);
        assert!(Upstream::parse("ftp://p.example.com:21").is_err());
        assert!(
            Upstream::parse("socks5://p.example.com").is_err(),
            "SOCKS5 没有默认端口"
        );
    }

    #[test]
    fn reads_exit_info_from_each_service_shape() {
        let ipinfo = serde_json::json!({"ip":"104.28.1.2","city":"Los Angeles","country":"US","timezone":"America/Los_Angeles"});
        let got = parse_exit(&ipinfo).unwrap();
        assert_eq!(got.timezone.as_deref(), Some("America/Los_Angeles"));
        assert_eq!(got.country.as_deref(), Some("US"));

        // 三家给经纬度的写法不一样，三种都要认出来——认不出来定位就跟不上出口。
        let with_loc =
            serde_json::json!({"ip":"104.28.1.2","loc":"52.520,13.405","timezone":"Europe/Berlin"});
        assert_eq!(
            parse_exit(&with_loc).unwrap().coords,
            Some((52.520, 13.405))
        );
        let with_latlon =
            serde_json::json!({"query":"85.214.1.2","lat":48.8566,"lon":2.3522,"status":"success"});
        assert_eq!(
            parse_exit(&with_latlon).unwrap().coords,
            Some((48.8566, 2.3522))
        );
        let spelled_out = serde_json::json!({"ip":"1.2.3.4","latitude":35.68,"longitude":139.69});
        assert_eq!(
            parse_exit(&spelled_out).unwrap().coords,
            Some((35.68, 139.69))
        );
        // 离谱的坐标不要：宁可不设，也不要给一个地球上没有的地方。
        let bogus = serde_json::json!({"ip":"1.2.3.4","latitude":999.0,"longitude":0.0});
        assert_eq!(parse_exit(&bogus).unwrap().coords, None);
        // 没给经纬度就是没有，不瞎猜。
        let no_loc = serde_json::json!({"ip":"1.2.3.4","timezone":"Europe/Berlin"});
        assert_eq!(parse_exit(&no_loc).unwrap().coords, None);

        let ipapi = serde_json::json!({"status":"success","countryCode":"DE","city":"Berlin","timezone":"Europe/Berlin","query":"85.214.1.2"});
        assert_eq!(parse_exit(&ipapi).unwrap().ip, "85.214.1.2");
        assert_eq!(parse_exit(&ipapi).unwrap().country.as_deref(), Some("DE"));

        // 国家只认两位代码（按它查地区表换语言）。给的是全名、或者代码和全名都给了，都要落到代码上。
        let both = serde_json::json!({"ip":"1.2.3.4","country":"Japan","country_code":"jp"});
        assert_eq!(parse_exit(&both).unwrap().country.as_deref(), Some("JP"));
        let name_only = serde_json::json!({"ip":"1.2.3.4","country":"United States"});
        assert_eq!(parse_exit(&name_only).unwrap().country, None);

        // 时区不像样就不用；IP 不像样整条不要。
        let odd = serde_json::json!({"ip":"1.2.3.4","timezone":"<script>"});
        assert_eq!(parse_exit(&odd).unwrap().timezone, None);
        assert!(parse_exit(&serde_json::json!({"ip":"not-an-ip"})).is_none());
        assert!(parse_exit(&serde_json::json!({})).is_none());
    }

    /// 回显服务：连上来说什么就回什么。
    async fn echo_server() -> u16 {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        port
    }

    /// 要账号密码的 HTTP 代理：认证对了就照 CONNECT 的目标真的连过去。
    async fn http_proxy(user: &'static str, pass: &'static str) -> u16 {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let want = format!("Basic {}", STANDARD.encode(format!("{user}:{pass}")));
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let want = want.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    while !head.ends_with(b"\r\n\r\n") {
                        head.push(s.read_u8().await.unwrap());
                    }
                    let head = String::from_utf8_lossy(&head).to_string();
                    if !head.contains(&format!("Proxy-Authorization: {want}")) {
                        let _ = s
                            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                            .await;
                        return;
                    }
                    let authority = head.split_whitespace().nth(1).unwrap().to_string();
                    let mut remote = TcpStream::connect(authority).await.unwrap();
                    s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                        .await
                        .unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut s, &mut remote).await;
                });
            }
        });
        port
    }

    /// 要账号密码的 SOCKS5 代理。记下浏览器要去的地址类型，用来确认域名没有在本机被解析。
    async fn socks5_proxy(
        user: &'static str,
        pass: &'static str,
        seen_atyp: Arc<Mutex<Option<u8>>>,
        forward_to: u16,
    ) -> u16 {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let seen = seen_atyp.clone();
                tokio::spawn(async move {
                    let mut h = [0u8; 2];
                    s.read_exact(&mut h).await.unwrap();
                    let mut m = vec![0u8; h[1] as usize];
                    s.read_exact(&mut m).await.unwrap();
                    if !m.contains(&2) {
                        let _ = s.write_all(&[5, 0xff]).await;
                        return;
                    }
                    s.write_all(&[5, 2]).await.unwrap();
                    let ulen = {
                        let mut v = [0u8; 2];
                        s.read_exact(&mut v).await.unwrap();
                        v[1] as usize
                    };
                    let mut u = vec![0u8; ulen];
                    s.read_exact(&mut u).await.unwrap();
                    let plen = s.read_u8().await.unwrap() as usize;
                    let mut p = vec![0u8; plen];
                    s.read_exact(&mut p).await.unwrap();
                    let ok = u == user.as_bytes() && p == pass.as_bytes();
                    s.write_all(&[1, if ok { 0 } else { 1 }]).await.unwrap();
                    if !ok {
                        return;
                    }
                    let mut r = [0u8; 4];
                    s.read_exact(&mut r).await.unwrap();
                    *seen.lock().await = Some(r[3]);
                    let skip = match r[3] {
                        1 => 4,
                        4 => 16,
                        _ => s.read_u8().await.unwrap() as usize,
                    };
                    let mut rest = vec![0u8; skip + 2];
                    s.read_exact(&mut rest).await.unwrap();
                    let mut remote = TcpStream::connect((Ipv4Addr::LOCALHOST, forward_to))
                        .await
                        .unwrap();
                    s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut s, &mut remote).await;
                });
            }
        });
        port
    }

    /// 扮演浏览器：对桥讲 SOCKS5（无认证），要求连到一个域名。返回应答码和连接。
    async fn browser_connect(bridge: u16, domain: &str, port: u16) -> (u8, TcpStream) {
        let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, bridge))
            .await
            .unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap();
        let mut h = [0u8; 2];
        s.read_exact(&mut h).await.unwrap();
        assert_eq!(h, [5, 0]);
        let mut req = vec![5, 1, 0, 3, domain.len() as u8];
        req.extend_from_slice(domain.as_bytes());
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut reply = [0u8; 10];
        s.read_exact(&mut reply).await.unwrap();
        (reply[1], s)
    }

    async fn roundtrip(mut s: TcpStream) {
        s.write_all(b"hello through the bridge").await.unwrap();
        let mut buf = [0u8; 24];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello through the bridge");
    }

    #[tokio::test]
    async fn carries_credentials_to_an_http_proxy_the_browser_cannot_authenticate_to() {
        let echo = echo_server().await;
        let proxy = http_proxy("user1", "p@ss:1").await;
        let up = Upstream::parse(&format!("http://user1:p%40ss%3A1@127.0.0.1:{proxy}")).unwrap();
        let bridge = Bridge::start(up).await.unwrap();

        let (code, s) = browser_connect(bridge.port, "localhost", echo).await;
        assert_eq!(code, 0);
        roundtrip(s).await;
        assert!(bridge.last_failure().await.is_none());
    }

    #[tokio::test]
    async fn a_wrong_password_is_reported_as_an_auth_failure_not_a_dead_page() {
        let echo = echo_server().await;
        let proxy = http_proxy("user1", "right").await;
        let up = Upstream::parse(&format!("http://user1:wrong@127.0.0.1:{proxy}")).unwrap();
        let bridge = Bridge::start(up).await.unwrap();

        let (code, _s) = browser_connect(bridge.port, "localhost", echo).await;
        assert_ne!(code, 0);
        assert_eq!(
            bridge.last_failure().await.unwrap().code,
            "PROXY_AUTH_FAILED"
        );
    }

    #[tokio::test]
    async fn an_unreachable_proxy_is_reported_as_unreachable() {
        // 绑一个端口再放掉，保证上面没人听。
        let dead = {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            l.local_addr().unwrap().port()
        };
        let up = Upstream::parse(&format!("socks5://127.0.0.1:{dead}")).unwrap();
        let bridge = Bridge::start(up).await.unwrap();
        let (code, _s) = browser_connect(bridge.port, "example.com", 443).await;
        assert_ne!(code, 0);
        assert_eq!(
            bridge.last_failure().await.unwrap().code,
            "PROXY_UNREACHABLE"
        );
    }

    #[tokio::test]
    async fn socks5_upstream_gets_credentials_and_the_unresolved_domain() {
        let echo = echo_server().await;
        let seen = Arc::new(Mutex::new(None));
        let proxy = socks5_proxy("u", "p", seen.clone(), echo).await;
        let up = Upstream::parse(&format!("socks5://u:p@127.0.0.1:{proxy}")).unwrap();
        let bridge = Bridge::start(up).await.unwrap();

        let (code, s) = browser_connect(bridge.port, "shop.example.com", 443).await;
        assert_eq!(code, 0);
        roundtrip(s).await;
        // 3 = 域名。上游收到的是域名本身，说明本机没有替它做 DNS 查询。
        assert_eq!(*seen.lock().await, Some(3));

        let bad = Upstream::parse(&format!("socks5://u:nope@127.0.0.1:{proxy}")).unwrap();
        let bridge = Bridge::start(bad).await.unwrap();
        let (code, _s) = browser_connect(bridge.port, "shop.example.com", 443).await;
        assert_ne!(code, 0);
        assert_eq!(
            bridge.last_failure().await.unwrap().code,
            "PROXY_AUTH_FAILED"
        );
    }

    #[tokio::test]
    async fn dropping_the_bridge_closes_the_door_and_the_tunnels() {
        let echo = echo_server().await;
        let proxy = http_proxy("a", "b").await;
        let up = Upstream::parse(&format!("http://a:b@127.0.0.1:{proxy}")).unwrap();
        let bridge = Bridge::start(up).await.unwrap();
        let port = bridge.port;
        let (_, mut s) = browser_connect(port, "localhost", echo).await;
        drop(bridge);
        tokio::time::sleep(Duration::from_millis(100)).await;

        let mut buf = [0u8; 1];
        let closed = matches!(s.read(&mut buf).await, Ok(0) | Err(_));
        assert!(closed, "环境停了，经过它的连接也要断");
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .is_err());
    }
}
