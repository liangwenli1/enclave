/**
 * 厂商许可证签名公钥（Ed25519，32 字节 raw，base64url）。
 *
 * 私钥只在许可证服务那台机器上（`apps/vendor`，首次启动时生成）。
 * 换密钥 = 让所有已签发的许可证失效，客户端必须同步更新这里再发新版。
 *
 * 核对当前部署用的是哪把：
 *   curl https://<官网域名>/api/v1/pubkey
 */
export const LICENSE_PUBLIC_KEY = "dJpAOBHjnTuXrsDbZWiHngIBMlvsFEIWl1wRP3-visM";
