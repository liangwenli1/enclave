import { createFileRoute } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  Empty,
  Field,
  Input,
  Panel,
  PageHeader,
} from "@/components/ui";
import { t } from "@/lib/i18n";
import { makeId } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/extensions")({ component: ExtensionsPage });

/** 这些权限意味着扩展能读到环境里的全部内容，勾给环境前得让用户看见。 */
const RISKY = ["<all_urls>", "tabs", "webRequest", "cookies", "proxy", "debugger"];

function ExtensionsPage() {
  const extensions = useEnclave((s) => s.extensions);
  const environments = useEnclave((s) => s.environments);
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6">
      <PageHeader
        title={t("extTitle")}
        status={`${extensions.length} 个扩展`}
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            {t("addExt")}
          </Button>
        }
      />

      <Panel className="overflow-hidden">
        {extensions.length === 0 ? (
          <Empty
            icon={<Puzzle className="size-8" />}
            title="暂无扩展"
            body="添加后可在环境详情中启用。"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                {t("addExt")}
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table min-w-[680px]">
              <thead>
                <tr>
                  <th>{t("name")}</th>
                  <th>路径</th>
                  <th>权限</th>
                  <th>被使用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {extensions.map((ext) => {
                  const used = environments.filter(
                    (e) => !e.deletedAt && e.extensionIds.includes(ext.id),
                  ).length;
                  return (
                    <tr key={ext.id}>
                      <td className="wrap">
                        <div className="font-medium text-ink">{ext.name}</div>
                      </td>
                      <td className="app-mono max-w-[22ch] truncate text-xs" title={ext.path}>
                        {ext.path}
                      </td>
                      <td>
                        {ext.highRisk ? (
                          <Badge tone="warn">{t("highRiskPerm")}</Badge>
                        ) : (
                          <span className="text-subtle">{ext.permissions.join(" ") || "—"}</span>
                        )}
                      </td>
                      <td className="text-subtle">{used ? `${used} 个环境` : "未使用"}</td>
                      <td>
                        <div className="flex justify-end">
                          <Button
                            variant="danger"
                            onClick={() => {
                              const store = useEnclave.getState();
                              for (const env of store.environments) {
                                if (env.extensionIds.includes(ext.id)) {
                                  store.patchEnv(env.id, {
                                    extensionIds: env.extensionIds.filter((id) => id !== ext.id),
                                  });
                                }
                              }
                              store.removeExt(ext.id);
                            }}
                          >
                            {t("delete")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {open ? <ExtDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function ExtDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [perms, setPerms] = useState("storage");
  const [error, setError] = useState("");

  const save = () => {
    const clean = path.trim();
    if (!clean) {
      setError("请填写已解压的扩展文件夹路径。");
      return;
    }
    if (clean.toLowerCase().endsWith(".crx")) {
      setError("仅支持加载已解压的文件夹，请先解压 .crx 文件。");
      return;
    }
    const permissions = perms.split(/[,\s]+/).filter(Boolean);
    useEnclave.getState().upsertExt({
      id: makeId("ext"),
      name: name.trim() || clean.split(/[\\/]/).pop() || "extension",
      source: "local-dir",
      path: clean,
      permissions,
      highRisk: permissions.some((p) => RISKY.includes(p)),
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("addExt")}>
        <div className="grid gap-4">
          <Field label={t("name")} hint="留空则使用文件夹名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="扩展文件夹" hint="manifest.json 所在的文件夹" error={error}>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\\ext\\my-extension"
            />
          </Field>
          <Field label="权限" hint="填写扩展 manifest.json 中声明的权限，以空格分隔">
            <Input value={perms} onChange={(e) => setPerms(e.target.value)} />
          </Field>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button variant="primary" onClick={save}>
            {t("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
