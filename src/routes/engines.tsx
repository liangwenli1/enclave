import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Field, Input, Panel, PageHeader } from "@/components/ui";
import { useLocale } from "@/lib/use-locale";
import { type CatalogEngine } from "@/lib/engines";
import { t } from "@/lib/i18n";
import { makeId } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/engines")({ component: EnginesPage });

function EnginesPage() {
  const locale = useLocale();
  const catalog = useEnclave((s) => s.searchCatalog);
  const environments = useEnclave((s) => s.environments);
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [url, setUrl] = useState("https://www.google.com/search?q={searchTerms}");

  const [errors, setErrors] = useState<{ name?: string; keyword?: string; url?: string }>({});

  const add = () => {
    const found: typeof errors = {};
    if (!name.trim()) found.name = "填一个名字。";
    if (!keyword.trim()) found.keyword = "填关键字，比如 google.com。";
    else if (catalog.some((e) => e.keyword === keyword.trim())) found.keyword = "这个关键字已经有了。";
    if (!/^https?:\/\/\S+$/.test(url.trim())) found.url = "要以 http:// 或 https:// 开头。";
    else if (!url.includes("{searchTerms}")) found.url = "地址里要有 {searchTerms}，它会被替换成搜索词。";
    setErrors(found);
    if (Object.keys(found).length) return;
    const engine: CatalogEngine = {
      id: makeId("se"),
      name: name.trim(),
      keyword: keyword.trim(),
      url: url.trim(),
      builtin: false,
    };
    useEnclave.getState().upsertEngine(engine);
    setName("");
    setKeyword("");
  };

  const remove = (id: string) => {
    useEnclave.getState().removeEngine(id);
    for (const env of environments) {
      if (env.searchEngine === id) {
        useEnclave.getState().patchEnv(env.id, { searchEngine: "none", searchProvider: undefined });
      }
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <PageHeader title={t(locale, "navEngines")} status={`${catalog.length} 个引擎`} />

      <Panel className="p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t(locale, "name")} error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Google" />
          </Field>
          <Field label={t(locale, "engineKeyword")} error={errors.keyword}>
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="google.com" />
          </Field>
          <Field label={t(locale, "engineUrl")} error={errors.url}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/search?q={searchTerms}"
            />
          </Field>
        </div>
        <Button variant="primary" className="mt-4" onClick={add}>
          <Plus className="size-4" />
          {t(locale, "engineAdd")}
        </Button>
      </Panel>

      <Panel className="mt-4 overflow-hidden">
        <table className="app-table">
          <thead>
            <tr>
              <th>{t(locale, "name")}</th>
              <th>{t(locale, "engineKeyword")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {catalog.map((engine) => (
              <tr key={engine.id}>
                <td className="font-medium text-ink">{engine.name}</td>
                <td className="app-mono text-xs">{engine.keyword}</td>
                <td>
                  <div className="flex justify-end">
                    {engine.builtin ? (
                      <span className="text-xs text-subtle">内置</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t(locale, "engineRemove")}
                        onClick={() => remove(engine.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
