import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Field, Input, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
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

  const add = () => {
    if (!name.trim() || !keyword.trim() || !url.includes("{searchTerms}")) return;
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
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <h1 className="text-xl font-semibold tracking-tight">{t(locale, "navEngines")}</h1>
      <p className="mt-1 text-sm text-subtle">{t(locale, "enginesHint")}</p>

      <Panel className="mt-5 p-4">
        <div className="mb-3 text-sm font-medium">{t(locale, "engineAdd")}</div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t(locale, "name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Google" />
          </Field>
          <Field label={t(locale, "engineKeyword")}>
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="google.com" />
          </Field>
          <Field label={t(locale, "engineUrl")}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/search?q={searchTerms}"
            />
          </Field>
        </div>
        <Button variant="primary" className="mt-3" onClick={add}>
          <Plus className="size-4" />
          {t(locale, "engineAdd")}
        </Button>
      </Panel>

      <div className="mt-4 grid gap-2">
        {catalog.map((engine) => (
          <Panel key={engine.id} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{engine.name}</div>
              <div className="truncate text-sm text-subtle">{engine.keyword}</div>
            </div>
            {engine.builtin ? null : (
              <Button variant="ghost" onClick={() => remove(engine.id)} aria-label={t(locale, "engineRemove")}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </Panel>
        ))}
      </div>
    </div>
  );
}
