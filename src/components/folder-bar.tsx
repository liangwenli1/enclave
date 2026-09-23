import { useState } from "react";
import { Button, Input, Panel } from "@/components/ui";
import { t } from "@/lib/i18n";
import { DEFAULT_FOLDER } from "@/lib/folders";
import { deleteFolder, putFolder, type Folder } from "@/lib/kernel/host-api";

/* 文件夹条：筛选 + 管理。

   文件夹是授权的单位——开给一个成员，里面的环境他全都看得到，之后新建进去的也自动跟着。
   所以删一个文件夹不是小事：里面的环境会回到「默认」，本来看得到它们的人就看不到了。
   删除确认里如实写着这句话。 */

/** 新文件夹的编号由名字生成：ASCII 留着，其余换成短横线，再缀上一点随机。 */
function idFrom(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const tail = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${tail}` : `f-${tail}`;
}

export function FolderBar({
  folders,
  picked,
  onPick,
  onChanged,
  mayEdit,
}: {
  folders: Folder[];
  picked: string;
  onPick: (id: string) => void;
  onChanged: () => Promise<void>;
  mayEdit: boolean;
}) {
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const run = async (key: string, job: () => Promise<{ ok: boolean; message?: string }>) => {
    setError("");
    setBusy(key);
    const res = await job();
    setBusy("");
    if (!res.ok) {
      setError(res.message ?? "操作未成功。");
      return false;
    }
    await onChanged();
    return true;
  };

  return (
    <div className="mb-4 grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={picked === ""} onClick={() => onPick("")}>
          {t("folderAll")}
        </Chip>
        {folders.map((f) => (
          <Chip key={f.id} active={picked === f.id} onClick={() => onPick(f.id)}>
            {f.name}
            <span className="ml-1.5 opacity-70">{f.profiles}</span>
          </Chip>
        ))}
        {mayEdit ? (
          <Button variant="ghost" onClick={() => setManaging((v) => !v)}>
            {t("folderManage")}
          </Button>
        ) : null}
      </div>

      {managing && mayEdit ? (
        <Panel>
          <div className="grid gap-4 p-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <label className="mb-2 block text-sm font-medium text-muted" htmlFor="new-folder">
                  {t("folderName")}
                </label>
                <Input
                  id="new-folder"
                  value={adding}
                  maxLength={60}
                  placeholder="例如：美国店铺"
                  onChange={(e) => setAdding(e.target.value)}
                />
              </div>
              <Button
                variant="primary"
                disabled={!adding.trim() || busy === "new"}
                onClick={() => {
                  const name = adding.trim();
                  void run("new", () => putFolder(idFrom(name), name)).then((okDone) => {
                    if (okDone) setAdding("");
                  });
                }}
              >
                {t("folderNew")}
              </Button>
            </div>

            <div className="grid gap-2">
              {folders.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-2">
                  {renaming?.id === f.id ? (
                    <>
                      <Input
                        className="max-w-[240px]"
                        value={renaming.name}
                        maxLength={60}
                        onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                      />
                      <Button
                        disabled={!renaming.name.trim() || busy === f.id}
                        onClick={() => {
                          void run(f.id, () => putFolder(f.id, renaming.name.trim())).then(
                            (okDone) => okDone && setRenaming(null),
                          );
                        }}
                      >
                        {t("save")}
                      </Button>
                      <Button variant="ghost" onClick={() => setRenaming(null)}>
                        {t("cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-[180px] text-sm text-ink">{f.name}</span>
                      <span className="text-[13px] text-subtle">{f.profiles} 个环境</span>
                      {f.id === DEFAULT_FOLDER ? (
                        <span className="text-[13px] text-subtle">{t("folderDefaultLocked")}</span>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            onClick={() => setRenaming({ id: f.id, name: f.name })}
                          >
                            {t("folderRename")}
                          </Button>
                          <Button
                            variant="ghost"
                            className="text-bad"
                            disabled={busy === f.id}
                            onClick={() => {
                              if (!confirm(`删除「${f.name}」？\n\n${t("folderDeleteNote")}`)) return;
                              void run(f.id, () => deleteFolder(f.id)).then((okDone) => {
                                if (okDone && picked === f.id) onPick("");
                              });
                            }}
                          >
                            {t("folderDelete")}
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            {error ? <p className="text-[13px] text-bad">{error}</p> : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
        active
          ? "border-transparent bg-accent text-accent-fg"
          : "border-line text-muted hover:border-line-strong hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
