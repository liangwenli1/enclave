export type CatalogEngine = {
  id: string;
  name: string;
  keyword: string;
  url: string;
  suggestUrl?: string;
  builtin: boolean;
};

export const BUILTIN_ENGINES: CatalogEngine[] = [
  {
    id: "google",
    name: "Google",
    keyword: "google.com",
    url: "https://www.google.com/search?q={searchTerms}",
    suggestUrl: "https://www.google.com/complete/search?client=chrome&q={searchTerms}",
    builtin: true,
  },
  {
    id: "bing",
    name: "Bing",
    keyword: "bing.com",
    url: "https://www.bing.com/search?q={searchTerms}",
    builtin: true,
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    keyword: "duckduckgo.com",
    url: "https://duckduckgo.com/?q={searchTerms}",
    builtin: true,
  },
  {
    id: "baidu",
    name: "百度",
    keyword: "baidu.com",
    url: "https://www.baidu.com/s?wd={searchTerms}",
    builtin: true,
  },
];

export function engineToProvider(engine: CatalogEngine) {
  return {
    name: engine.name,
    keyword: engine.keyword,
    url: engine.url,
    suggestUrl: engine.suggestUrl,
  };
}

export function findEngine(catalog: CatalogEngine[], id: string | undefined) {
  if (!id || id === "none") return undefined;
  return catalog.find((e) => e.id === id);
}
