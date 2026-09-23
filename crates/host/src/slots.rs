//! 一个环境一把钥匙：这台电脑现在手里有哪些钥匙，以及该给谁发钥匙。
//!
//! 所有者和管理员的电脑拿得到团队密钥（DK），所以能打开每个槽位的 `boxTeam`；
//! 操作员的电脑没有 DK，只有服务器转交的、用它自己公钥包着的那几份 `grant`。
//! 两条路得到的都是同一种东西：这个槽位现在的那把钥匙。
//!
//! 服务器全程只转交包装。它给不出钥匙，也换不了钥匙——换了，客户端就解不开。

use crate::sync::{self, DeviceKey};
use crate::vault::DataKey;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone)]
pub struct SlotKey {
    pub key_id: String,
    pub key: DataKey,
}

/// 这一轮同步里，这台电脑能用的全部钥匙。
#[derive(Default)]
pub struct Keyring {
    keys: HashMap<String, SlotKey>,
    /// 拿得到团队密钥的电脑才能建槽位、换钥匙、给别人发钥匙。
    pub holds_team_key: bool,
    /// 服务器说这几个槽位该换钥匙了（有人被移出团队，他解得开它们）。
    pub stale: Vec<String>,
    /// 还缺的那些"某台设备该拿到某个槽位的钥匙"。
    pub wanted: Vec<Wanted>,
}

pub struct Wanted {
    pub slot: String,
    pub key_id: String,
    pub device_id: String,
    pub public_key: String,
    pub digits: String,
}

impl Keyring {
    pub fn get(&self, slot: &str) -> Option<&SlotKey> {
        self.keys.get(slot)
    }

    pub fn env(&self, env_id: &str) -> Option<&SlotKey> {
        self.get(&sync::env_slot(env_id))
    }

    pub fn insert(&mut self, slot: String, key: SlotKey) {
        self.keys.insert(slot, key);
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// 把服务器给的那一堆包装拆开。拆不开的（钥匙换过了、或者根本没发给我）直接跳过：
    /// 少一把钥匙只是少同步一个环境，不能让整轮同步失败。
    pub fn build(view: &Value, dk: Option<&DataKey>, device: &DeviceKey) -> Self {
        let mut ring = Keyring {
            holds_team_key: view["holdsTeamKey"] == true,
            ..Default::default()
        };
        for s in view["slots"].as_array().cloned().unwrap_or_default() {
            let (Some(slot), Some(key_id)) = (s["slot"].as_str(), s["keyId"].as_str()) else {
                continue;
            };
            if s["stale"] == true {
                ring.stale.push(slot.to_string());
            }
            let opened = match (dk, s["boxTeam"].as_str()) {
                (Some(dk), Some(boxed)) => sync::open_slot(dk, slot, key_id, boxed).ok(),
                _ => s["grant"]["ephemeral"]
                    .as_str()
                    .zip(s["grant"]["box"].as_str())
                    .and_then(|(e, b)| device.unseal(e, b).ok()),
            };
            if let Some(key) = opened {
                ring.insert(
                    slot.to_string(),
                    SlotKey {
                        key_id: key_id.to_string(),
                        key,
                    },
                );
            }
        }
        for w in view["wanted"].as_array().cloned().unwrap_or_default() {
            let (Some(slot), Some(key_id), Some(device_id), Some(public_key), Some(digits)) = (
                w["slot"].as_str(),
                w["keyId"].as_str(),
                w["deviceId"].as_str(),
                w["publicKey"].as_str(),
                w["digits"].as_str(),
            ) else {
                continue;
            };
            ring.wanted.push(Wanted {
                slot: slot.to_string(),
                key_id: key_id.to_string(),
                device_id: device_id.to_string(),
                public_key: public_key.to_string(),
                digits: digits.to_string(),
            });
        }
        ring
    }
}

/// 一把新钥匙 + 用团队密钥包好的那一份。建槽位和换钥匙都用它。
pub fn mint(dk: &DataKey, slot: &str) -> anyhow::Result<(SlotKey, String)> {
    let key = sync::new_slot_key();
    let key_id = sync::new_key_id();
    let boxed = sync::seal_slot(dk, slot, &key_id, &key)?;
    Ok((SlotKey { key_id, key }, boxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 每个测试一个独立目录：设备私钥在非 Win/mac 上回落成目录里的一个文件。
    fn dev() -> (std::path::PathBuf, DeviceKey) {
        let dir = std::env::temp_dir().join(format!(
            "enclave-slots-{}",
            hex::encode(sync::new_key_id())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let key = DeviceKey::load(&dir).unwrap();
        (dir, key)
    }

    #[test]
    fn the_team_key_opens_every_slot_it_is_given() {
        let (dir, device) = dev();
        let dk: DataKey = [7u8; 32];
        let (shop, boxed) = mint(&dk, "env:shop").unwrap();

        let view = json!({
            "holdsTeamKey": true,
            "slots": [{ "slot": "env:shop", "keyId": shop.key_id, "boxTeam": boxed, "stale": false }],
        });
        let ring = Keyring::build(&view, Some(&dk), &device);
        assert_eq!(ring.env("shop").unwrap().key, shop.key);
        assert!(ring.stale.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 操作员没有团队密钥：他只能靠发给自己这台设备的那一份拿到钥匙，
    /// 而且服务器塞给他别人的包装也没用——拆不开就当没有。
    #[test]
    fn an_operator_opens_only_what_was_addressed_to_this_device() {
        let (dir, device) = dev();
        let dk: DataKey = [9u8; 32];
        let (mine, _) = mint(&dk, "env:mine").unwrap();
        let (theirs, boxed_theirs) = mint(&dk, "env:theirs").unwrap();
        let (eph, boxed) = sync::seal_for(&device.public_b64(), &mine.key).unwrap();

        let view = json!({
            "holdsTeamKey": false,
            "slots": [
                { "slot": "env:mine", "keyId": mine.key_id, "stale": false,
                  "grant": { "ephemeral": eph, "box": boxed } },
                // 服务器把别人的那一份也塞过来：他没有团队密钥，拆不开。
                { "slot": "env:theirs", "keyId": theirs.key_id, "boxTeam": boxed_theirs, "stale": true },
            ],
        });
        let ring = Keyring::build(&view, None, &device);
        assert_eq!(ring.env("mine").unwrap().key, mine.key);
        assert!(ring.env("theirs").is_none(), "不该解开没发给他的那一个");
        assert_eq!(ring.len(), 1);
        assert!(!ring.holds_team_key);
        assert_eq!(ring.stale, vec!["env:theirs"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_rotated_slot_is_not_opened_by_the_old_wrapping() {
        let (dir, device) = dev();
        let dk: DataKey = [3u8; 32];
        let (_, boxed) = mint(&dk, "env:shop").unwrap();
        // 服务器说编号换了，包装却还是旧的那一份：解不开，当没有这把钥匙。
        let view = json!({
            "holdsTeamKey": true,
            "slots": [{ "slot": "env:shop", "keyId": "0000000000000000", "boxTeam": boxed, "stale": true }],
        });
        assert!(Keyring::build(&view, Some(&dk), &device).env("shop").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
