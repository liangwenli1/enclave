/**
 * 厂商 API 地址。打包时用 `VITE_ENCLAVE_VENDOR_URL` 指向正式域名。
 *
 * 没配就是空字符串：工作台照常跑，只是不能登录，额度停在免费档 ——
 * 不会出现一个点了没反应的登录按钮。
 */
export const VENDOR_URL: string = (import.meta.env.VITE_ENCLAVE_VENDOR_URL ?? "").replace(/\/$/, "");
export const vendorConfigured = VENDOR_URL !== "";
