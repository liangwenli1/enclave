//! 环境、代理、代理密码的"真相"。
//!
//! 以前这些只存在工作台页面的 localStorage 里：页面不开，谁也碰不到，更谈不上加密后同步。
//! 现在它们在 Host 的 sqlite 里，页面只是它的一个界面。
//!
//! 环境和代理的内容对 Host 来说是一段不透明的 JSON——长什么样由工作台定义，
//! Host 只认 id，以及启动时要用到的那几个代理字段。密码单独一张表，用数据密钥加密。

use crate::vault::{self, DataKey};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

/// 一份文档最大多少。环境带着 200 条时间线，正常几十 KB。
const MAX_DOC: usize = 512 * 1024;

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Clone, Copy)]
pub enum Kind {
    Environment,
    Proxy,
    /// 自动化流程。团队资产，和代理一样走共用的那把钥匙。
    Workflow,
}

impl Kind {
    fn table(self) -> &'static str {
        match self {
            Kind::Environment => "environments",
            Kind::Proxy => "proxies",
            Kind::Workflow => "workflows",
        }
    }

    /// 和云端约定的名字。
    pub fn wire(self) -> &'static str {
        match self {
            Kind::Environment => "environment",
            Kind::Proxy => "proxy",
            Kind::Workflow => "workflow",
        }
    }

    pub fn parse(wire: &str) -> Option<Self> {
        match wire {
            "environment" => Some(Kind::Environment),
            "proxy" => Some(Kind::Proxy),
            "workflow" => Some(Kind::Workflow),
            _ => None,
        }
    }
}

/// 一条等着上传的改动。
pub struct Pending {
    pub kind: Kind,
    pub id: String,
    pub version: i64,
    pub deleted: bool,
    /// 删掉的条目没有内容。
    pub doc: Option<Value>,
}

/// id 会出现在路径和附加认证数据里：字母、数字、下划线、连字符、冒号。
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':'))
}

/// 密码在 doc_versions 里的类型名。它不是环境也不是代理，单独一条路同步。
pub const SECRET_KIND: &str = "secret";

fn bump_secret(conn: &Connection, id: &str, deleted: bool) -> Result<()> {
    conn.execute(
        "INSERT INTO doc_versions (kind, id, version, deleted, synced) VALUES (?1, ?2, 1, ?3, 0)
         ON CONFLICT(kind, id) DO UPDATE SET version = doc_versions.version + 1, deleted = ?3, synced = 0",
        params![SECRET_KIND, id, deleted as i64],
    )?;
    Ok(())
}

fn now_ms() -> i64 {
    crate::kernel::now_ms() as i64
}

/// 本机改了一条：版本 +1，标成等着上传。
fn bump(conn: &Connection, kind: Kind, id: &str, deleted: bool) -> Result<()> {
    conn.execute(
        "INSERT INTO doc_versions (kind, id, version, deleted, synced) VALUES (?1, ?2, 1, ?3, 0)
         ON CONFLICT(kind, id) DO UPDATE SET version = doc_versions.version + 1, deleted = ?3, synced = 0",
        params![kind.wire(), id, deleted as i64],
    )?;
    Ok(())
}

fn set_version(
    conn: &Connection,
    kind: Kind,
    id: &str,
    version: i64,
    deleted: bool,
    synced: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO doc_versions (kind, id, version, deleted, synced) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(kind, id) DO UPDATE SET version = ?3, deleted = ?4, synced = ?5",
        params![kind.wire(), id, version, deleted as i64, synced as i64],
    )?;
    Ok(())
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        let conn = Connection::open(dir.join("store.db"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS proxies      (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS workflows    (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL);
             -- 同步用：每条文档的版本号，以及「这条已经删了」的墓碑（不然另一台电脑会把它推回来）。
             CREATE TABLE IF NOT EXISTS doc_versions (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
                                                      deleted INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0,
                                                      PRIMARY KEY (kind, id));
             -- 每个环境的登录态同步到第几版了。本机导出一次就 +1。
             CREATE TABLE IF NOT EXISTS cookie_versions (env_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
                                                         synced INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS secrets      (id TEXT PRIMARY KEY, nonce BLOB NOT NULL, ct BLOB NOT NULL, updated_at INTEGER NOT NULL);
             -- 服务器说过的话里，断网之后还得算数的那几件。现在只有一条：这个人在团队里是什么角色。
             CREATE TABLE IF NOT EXISTS meta         (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             -- 批准过的设备和它当时的公钥。之后自动给它发钥匙，只认这一份：
             -- 服务器把公钥换成别的，就不发，等用户重新核对那 6 位数字。
             CREATE TABLE IF NOT EXISTS known_devices (device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list(&self, kind: Kind) -> Result<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT doc FROM {} ORDER BY updated_at DESC",
            kind.table()
        ))?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    pub fn get(&self, kind: Kind, id: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().unwrap();
        let doc: Option<String> = conn
            .query_row(
                &format!("SELECT doc FROM {} WHERE id = ?1", kind.table()),
                [id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match doc {
            Some(d) => Some(serde_json::from_str(&d)?),
            None => None,
        })
    }

    /// 写入一份文档。文档自己的 id 必须就是路径里那个，不然一个请求能改到别的条目头上。
    pub fn put(&self, kind: Kind, id: &str, doc: &Value) -> Result<()> {
        if !valid_id(id) || doc.get("id").and_then(Value::as_str) != Some(id) {
            bail!("id 不合法，或者和内容里的 id 对不上");
        }
        let text = serde_json::to_string(doc)?;
        if text.len() > MAX_DOC {
            bail!("内容太大");
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!(
                "INSERT INTO {} (id, doc, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
                kind.table()
            ),
            params![id, text, now_ms()],
        )?;
        bump(&conn, kind, id, false)?;
        Ok(())
    }

    /// 原样再写一遍：版本加一、重新排队上传。换钥匙之后要用新钥匙重传时用它。
    pub fn touch(&self, kind: Kind, id: &str) -> Result<()> {
        if let Some(doc) = self.get(kind, id)? {
            self.put(kind, id, &doc)?;
        }
        Ok(())
    }

    /// 从云端拉下来的一条：版本号是服务器给的，不自己加，也不再标成"等着上传"。
    pub fn put_remote(&self, kind: Kind, id: &str, doc: &Value, version: i64) -> Result<()> {
        if !valid_id(id) || doc.get("id").and_then(Value::as_str) != Some(id) {
            bail!("id 不合法，或者和内容里的 id 对不上");
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!(
                "INSERT INTO {} (id, doc, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
                kind.table()
            ),
            params![id, serde_json::to_string(doc)?, now_ms()],
        )?;
        set_version(&conn, kind, id, version, false, true)
    }

    /// 云端说这条已经删了。
    pub fn delete_remote(&self, kind: Kind, id: &str, version: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(&format!("DELETE FROM {} WHERE id = ?1", kind.table()), [id])?;
        if matches!(kind, Kind::Proxy) {
            conn.execute("DELETE FROM secrets WHERE id = ?1", [format!("proxy:{id}")])?;
        }
        set_version(&conn, kind, id, version, true, true)
    }

    /// 还没传上去的改动。
    pub fn pending(&self) -> Result<Vec<Pending>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT kind, id, version, deleted FROM doc_versions WHERE synced = 0 ORDER BY version",
        )?;
        let rows: Vec<(String, String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let mut out = Vec::new();
        for (kind, id, version, deleted) in rows {
            let Some(kind) = Kind::parse(&kind) else {
                continue;
            };
            let doc = if deleted == 1 {
                None
            } else {
                let text: Option<String> = conn
                    .query_row(
                        &format!("SELECT doc FROM {} WHERE id = ?1", kind.table()),
                        [&id],
                        |r| r.get(0),
                    )
                    .optional()?;
                match text {
                    Some(t) => Some(serde_json::from_str(&t)?),
                    // 本机已经没有了、墓碑却说没删：当成删了传上去，别卡在这里。
                    None => None,
                }
            };
            out.push(Pending {
                kind,
                id,
                version,
                deleted: deleted == 1 || doc.is_none(),
                doc,
            });
        }
        Ok(out)
    }

    /// 这几条已经传上去了。
    pub fn mark_synced(&self, items: &[(Kind, String, i64)]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for (kind, id, version) in items {
            // 标记的时候如果本机又改了（版本号已经更大），就别盖掉——下一轮再传。
            conn.execute(
                "UPDATE doc_versions SET synced = 1 WHERE kind = ?1 AND id = ?2 AND version = ?3",
                params![kind.wire(), id, version],
            )?;
        }
        Ok(())
    }

    /// 本机每条文档现在是第几版。拉下来的时候用它判断"云端那条是不是更新"。
    pub fn versions(&self) -> Result<std::collections::HashMap<(String, String), i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT kind, id, version FROM doc_versions")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, i64>(2)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 换了密钥、或者刚接上同步：把本机现有的东西全部标成"等着上传"。
    pub fn mark_all_pending(&self) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE doc_versions SET synced = 0", [])?;
        Ok(())
    }

    /// 删一份文档。删代理时把它的密码一起删掉：密码不该比它的主人活得久。
    pub fn delete(&self, kind: Kind, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(&format!("DELETE FROM {} WHERE id = ?1", kind.table()), [id])?;
        if matches!(kind, Kind::Proxy) {
            conn.execute("DELETE FROM secrets WHERE id = ?1", [format!("proxy:{id}")])?;
        }
        // 留个墓碑，另一台电脑才知道这条是被删了，而不是它那边新加的。
        bump(&conn, kind, id, true)
    }

    /* ── 密码 ─────────────────────────────────────────────── */

    fn aad(id: &str) -> Vec<u8> {
        format!("enclave-secret-v1:{id}").into_bytes()
    }

    /* ── 服务器说过的话 ─────────────────────────────────────
       角色要落盘：操作员拔掉网线再来导出，本机也得照样拒绝。
       登录必然经过服务器，所以登录过的机器上这一条一定是有的。 */

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    /// 批准一台设备时把它的公钥钉下来。
    pub fn pin_device(&self, device_id: &str, public_key: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO known_devices (device_id, public_key) VALUES (?1, ?2)
             ON CONFLICT(device_id) DO UPDATE SET public_key = excluded.public_key",
            rusqlite::params![device_id, public_key],
        )?;
        Ok(())
    }

    pub fn unpin_device(&self, device_id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM known_devices WHERE device_id = ?1", [device_id])?;
        Ok(())
    }

    /// 这台设备的公钥还是批准时那一把吗。没批准过的、或者换过的，都是 false。
    pub fn device_pinned(&self, device_id: &str, public_key: &str) -> bool {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT public_key FROM known_devices WHERE device_id = ?1",
                [device_id],
                |r| r.get::<_, String>(0),
            )
            .map(|saved| saved == public_key)
            .unwrap_or(false)
    }

    pub fn meta(&self, key: &str) -> Option<String> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .ok()
    }

    pub fn secret_ids(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM secrets ORDER BY id")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    pub fn put_secret(&self, key: &DataKey, id: &str, value: &str) -> Result<()> {
        if !valid_id(id) || value.is_empty() || value.len() > 4096 {
            bail!("密码为空、太长，或者 id 不合法");
        }
        let (nonce, ct) = vault::seal(key, &Self::aad(id), value.as_bytes())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO secrets (id, nonce, ct, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET nonce = excluded.nonce, ct = excluded.ct, updated_at = excluded.updated_at",
            params![id, nonce, ct, now_ms()],
        )?;
        bump_secret(&conn, id, false)
    }

    pub fn secret(&self, key: &DataKey, id: &str) -> Result<Option<String>> {
        let row: Option<(Vec<u8>, Vec<u8>)> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT nonce, ct FROM secrets WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((nonce, ct)) = row else {
            return Ok(None);
        };
        let plain = vault::open(key, &Self::aad(id), &nonce, &ct)?;
        Ok(Some(String::from_utf8(plain).context("密码不是文字")?))
    }

    /// 从云端收到的一条密码：版本号是服务器给的，不自己加，也不标成"等着上传"。
    pub fn put_secret_remote(&self, key: &DataKey, id: &str, value: &str, version: i64) -> Result<()> {
        self.put_secret(key, id, value)?;
        self.conn.lock().unwrap().execute(
            "UPDATE doc_versions SET version = ?2, deleted = 0, synced = 1 WHERE kind = ?1 AND id = ?3",
            params![SECRET_KIND, version, id],
        )?;
        Ok(())
    }

    /// 还没传上去的密码改动。删掉的留一个墓碑，另一台电脑才知道是被删了。
    pub fn pending_secrets(&self) -> Result<Vec<(String, i64, bool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, version, deleted FROM doc_versions WHERE kind = ?1 AND synced = 0 ORDER BY version",
        )?;
        let rows = stmt
            .query_map([SECRET_KIND], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)? == 1))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn secret_versions(&self) -> Result<std::collections::HashMap<String, i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, version FROM doc_versions WHERE kind = ?1 AND deleted = 0")?;
        let rows = stmt.query_map([SECRET_KIND], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (id, v) = row?;
            out.insert(id, v);
        }
        Ok(out)
    }

    /// 换了共用钥匙之后，密码要用新钥匙重传一遍。
    pub fn touch_secret(&self, id: &str) -> Result<()> {
        bump_secret(&self.conn.lock().unwrap(), id, false)
    }

    pub fn mark_secret_synced(&self, id: &str, version: i64) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE doc_versions SET synced = 1 WHERE kind = ?1 AND id = ?2 AND version = ?3",
            params![SECRET_KIND, id, version],
        )?;
        Ok(())
    }

    /// 云端说这条密码删了。
    pub fn delete_secret_remote(&self, id: &str, version: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM secrets WHERE id = ?1", [id])?;
        conn.execute(
            "INSERT INTO doc_versions (kind, id, version, deleted, synced) VALUES (?1, ?2, ?3, 1, 1)
             ON CONFLICT(kind, id) DO UPDATE SET version = ?3, deleted = 1, synced = 1",
            params![SECRET_KIND, id, version],
        )?;
        Ok(())
    }

    pub fn delete_secret(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM secrets WHERE id = ?1", [id])?;
        bump_secret(&conn, id, true)
    }

    pub fn clear_secrets(&self) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM secrets", [])?;
        Ok(())
    }

    pub fn all_secrets(&self, key: &DataKey) -> Result<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        for id in self.secret_ids()? {
            if let Some(v) = self.secret(key, &id)? {
                out.insert(id, v);
            }
        }
        Ok(out)
    }

    /* ── 登录态的版本 ─────────────────────────────────────── */

    /// 刚从浏览器里导出一份：版本 +1，标成等着上传。返回新的版本号。
    pub fn bump_cookies(&self, env_id: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cookie_versions (env_id, version, synced) VALUES (?1, 1, 0)
             ON CONFLICT(env_id) DO UPDATE SET version = cookie_versions.version + 1, synced = 0",
            [env_id],
        )?;
        Ok(conn.query_row(
            "SELECT version FROM cookie_versions WHERE env_id = ?1",
            [env_id],
            |r| r.get(0),
        )?)
    }

    pub fn cookie_version(&self, env_id: &str) -> i64 {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT version FROM cookie_versions WHERE env_id = ?1",
                [env_id],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// 还没传上去的登录态是哪几个环境。
    pub fn pending_cookies(&self) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT env_id, version FROM cookie_versions WHERE synced = 0")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn mark_cookies_synced(&self, env_id: &str, version: i64) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE cookie_versions SET synced = 1 WHERE env_id = ?1 AND version = ?2",
            params![env_id, version],
        )?;
        Ok(())
    }

    /// 从云端收下一份：版本号是云端那个，不标成等着上传。
    pub fn set_cookie_version(&self, env_id: &str, version: i64) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO cookie_versions (env_id, version, synced) VALUES (?1, ?2, 1)
             ON CONFLICT(env_id) DO UPDATE SET version = ?2, synced = 1",
            params![env_id, version],
        )?;
        Ok(())
    }

    /// 这个环境是不是「只存本机」——用户可以逐个环境关掉登录态同步。
    pub fn local_only(&self, env_id: &str) -> bool {
        self.get(Kind::Environment, env_id)
            .ok()
            .flatten()
            .and_then(|d| d.get("localOnly").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    /// 换数据密钥：先用旧钥匙全部解出来，再用新钥匙全部写回去。
    /// 中途任何一条解不开就整个放弃，不会留下一半新一半旧。
    pub fn rekey(&self, old: &DataKey, new: &DataKey) -> Result<usize> {
        let all = self.all_secrets(old)?;
        for (id, value) in &all {
            self.put_secret(new, id, value)?;
        }
        Ok(all.len())
    }

    /// 启动环境要用的代理地址，带上账号密码。密码只在这里被读出来，读完直接交给代理桥。
    /// 返回 Err((原因码, 给人看的话))。
    pub fn proxy_url(
        &self,
        key: Option<&DataKey>,
        proxy_id: &str,
    ) -> Result<String, (String, String)> {
        let fail = |code: &str, msg: String| (code.to_string(), msg);
        let doc = self
            .get(Kind::Proxy, proxy_id)
            .ok()
            .flatten()
            .ok_or_else(|| {
                fail(
                    "PROXY_INVALID",
                    "这个环境绑定的代理已经不存在了，到环境页重新选一个。".into(),
                )
            })?;
        let text = |k: &str| doc.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let (protocol, host) = (text("protocol"), text("host"));
        let port = doc.get("port").and_then(Value::as_u64).unwrap_or(0);
        let name = text("name");
        if !matches!(protocol.as_str(), "http" | "https" | "socks5")
            || host.is_empty()
            || port == 0
            || port > 65535
        {
            return Err(fail(
                "PROXY_INVALID",
                format!("代理「{name}」的地址不完整。"),
            ));
        }
        let username = doc
            .pointer("/auth/username")
            .and_then(Value::as_str)
            .unwrap_or("");
        if username.is_empty() {
            return Ok(format!("{protocol}://{host}:{port}"));
        }
        let key =
            key.ok_or_else(|| fail("VAULT_LOCKED", "代理密码锁着，先输入应用锁的口令。".into()))?;
        // 要用户名却拿不到密码：不能拿空密码去连，那样认证失败后流量走向不可控。
        let password = self
            .secret(key, &format!("proxy:{proxy_id}"))
            .ok()
            .flatten()
            .ok_or_else(|| {
                fail(
                    "PROXY_PASSWORD_MISSING",
                    format!("代理「{name}」的密码不在这台电脑上，到代理页补填。"),
                )
            })?;
        let enc = |s: &str| {
            percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
        };
        Ok(format!(
            "{protocol}://{}:{}@{host}:{port}",
            enc(username),
            enc(&password)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp() -> (std::path::PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!(
            "enclave-store-{}",
            crate::kernel::now_ms() as u128
                + std::process::id() as u128 * 7919
                + rand::random::<u16>() as u128
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir).unwrap();
        (dir, store)
    }

    #[test]
    fn documents_survive_a_restart_and_ids_cannot_be_spoofed() {
        let (dir, store) = temp();
        store
            .put(
                Kind::Environment,
                "env_a",
                &json!({"id":"env_a","name":"shop-us-01"}),
            )
            .unwrap();
        store
            .put(
                Kind::Environment,
                "env_a",
                &json!({"id":"env_a","name":"renamed"}),
            )
            .unwrap();
        // 路径说改 env_b，内容说自己是 env_a：不收。
        assert!(store
            .put(Kind::Environment, "env_b", &json!({"id":"env_a"}))
            .is_err());
        assert!(store
            .put(Kind::Environment, "../x", &json!({"id":"../x"}))
            .is_err());
        drop(store);
        let again = Store::open(&dir).unwrap();
        let list = again.list(Kind::Environment).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "renamed");
        again.delete(Kind::Environment, "env_a").unwrap();
        assert!(again.get(Kind::Environment, "env_a").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn passwords_are_encrypted_at_rest_and_die_with_their_proxy() {
        let (dir, store) = temp();
        let key: DataKey = [3u8; 32];
        store.put(Kind::Proxy, "prx_1", &json!({"id":"prx_1","name":"住宅","protocol":"socks5","host":"gw.example","port":1080,"auth":{"username":"u ser"}})).unwrap();
        store.put_secret(&key, "proxy:prx_1", "p@ss:word/").unwrap();
        let raw = std::fs::read(dir.join("store.db")).unwrap();
        assert!(
            !raw.windows(10).any(|w| w == b"p@ss:word/"),
            "磁盘上不该有明文密码"
        );
        assert_eq!(store.secret_ids().unwrap(), vec!["proxy:prx_1"]);
        assert_eq!(
            store.proxy_url(Some(&key), "prx_1").unwrap(),
            "socks5://u%20ser:p%40ss%3Aword%2F@gw.example:1080"
        );
        // 钥匙不对（换过数据密钥）、锁着、密码没了，各有各的原因码。
        assert!(store.secret(&[4u8; 32], "proxy:prx_1").is_err());
        assert_eq!(
            store.proxy_url(None, "prx_1").unwrap_err().0,
            "VAULT_LOCKED"
        );
        store.delete_secret("proxy:prx_1").unwrap();
        assert_eq!(
            store.proxy_url(Some(&key), "prx_1").unwrap_err().0,
            "PROXY_PASSWORD_MISSING"
        );
        assert_eq!(
            store.proxy_url(Some(&key), "prx_gone").unwrap_err().0,
            "PROXY_INVALID"
        );
        // 不要密码的代理，锁着也能用。
        store.put(Kind::Proxy, "prx_2", &json!({"id":"prx_2","name":"直连机房","protocol":"http","host":"10.0.0.2","port":3128})).unwrap();
        assert_eq!(
            store.proxy_url(None, "prx_2").unwrap(),
            "http://10.0.0.2:3128"
        );
        store.put_secret(&key, "proxy:prx_2", "x").unwrap();
        store.delete(Kind::Proxy, "prx_2").unwrap();
        assert!(
            store.secret_ids().unwrap().is_empty(),
            "删代理要把它的密码一起删掉"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
