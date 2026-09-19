export type SiteAccount = {
  email: string;
  plan: "free" | "solo" | "pro";
  createdAt: number;
};

const KEY = "enclave.site.account";

export function readSiteAccount(): SiteAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SiteAccount;
    if (!parsed.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSiteAccount(account: SiteAccount): void {
  localStorage.setItem(KEY, JSON.stringify(account));
}

export function clearSiteAccount(): void {
  localStorage.removeItem(KEY);
}
