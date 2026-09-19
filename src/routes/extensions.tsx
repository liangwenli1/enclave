import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Button, Dialog, DialogContent, Field, Input, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { t } from "@/lib/i18n";
import { makeId } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/extensions")({ component: ExtensionsPage });

function ExtensionsPage() {
  const locale = useLocale();
  const extensions = useEnclave((s) => s.extensions);
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{t(locale, "extTitle")}</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-subtle">{t(locale, "extensionsHint")}</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t(locale, "addExt")}
        </Button>
      </div>
      <div className="grid gap-2">
        {extensions.length === 0 ? (
          <Panel className="p-8 text-center text-[13px] text-subtle">{t(locale, "none")}</Panel>
        ) : (
          extensions.map((ext) => (
            <Panel key={ext.id} className="flex items-center justify-between gap-3 p-4">
              <div>
                <div className="font-medium">{ext.name}</div>
                <div className="font-mono text-[12px] text-subtle">{ext.path}</div>
              </div>
              <div className="flex items-center gap-2">
                {ext.highRisk ? <Badge tone="bad">{t(locale, "highRiskPerm")}</Badge> : null}
                <Button variant="danger" onClick={() => useEnclave.getState().removeExt(ext.id)}>
                  {t(locale, "delete")}
                </Button>
              </div>
            </Panel>
          ))
        )}
      </div>
      {open ? (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <ExtDialog onClose={() => setOpen(false)} />
        </Dialog>
      ) : null}
    </div>
  );
}

function ExtDialog({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [perms, setPerms] = useState("storage");
  return (
    <DialogContent title={t(locale, "addExt")}>
      <div className="grid gap-3">
        <Field label={t(locale, "name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="crx / dir">
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to.crx" />
        </Field>
        <Field label="permissions">
          <Input value={perms} onChange={(e) => setPerms(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{t(locale, "cancel")}</Button>
        <Button
          variant="primary"
          onClick={() => {
            const permissions = perms.split(/[,\s]+/).filter(Boolean);
            const highRisk = permissions.some((p) =>
              ["<all_urls>", "tabs", "webRequest", "cookies"].includes(p),
            );
            useEnclave.getState().upsertExt({
              id: makeId("ext"),
              name: name || "extension",
              source: path.endsWith(".crx") ? "local-crx" : "local-dir",
              path,
              permissions,
              highRisk,
              enabledByDefault: false,
            });
            onClose();
          }}
        >
          {t(locale, "save")}
        </Button>
      </div>
    </DialogContent>
  );
}
