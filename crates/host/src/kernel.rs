async fn apply_search_engine(
    user_data_dir: &Path,
    engine: Option<&str>,
    provider: Option<&SearchProvider>,
) -> Result<Option<PathBuf>> {
    let ext_dir = user_data_dir.join("enclave-search");
    let policy_dir = user_data_dir.join("policies").join("managed");
    let policy_path = policy_dir.join("enclave.json");
    let chosen = resolve_search_provider(engine, provider);
    if chosen.is_none() {
        let _ = tokio::fs::remove_dir_all(&ext_dir).await;
        let _ = tokio::fs::remove_file(&policy_path).await;
        return Ok(None);
    }
    let chosen = chosen.unwrap();
    let favicon = favicon_url_for(&chosen.keyword, &chosen.url);

    tokio::fs::create_dir_all(&policy_dir).await?;
    let mut policy = json!({
        "DefaultSearchProviderEnabled": true,
        "DefaultSearchProviderName": chosen.name,
        "DefaultSearchProviderKeyword": chosen.keyword,
        "DefaultSearchProviderSearchURL": chosen.url,
        "DefaultSearchProviderFaviconURL": favicon,
        "DefaultSearchProviderEncodings": ["UTF-8"]
    });
    if !chosen.suggest_url.is_empty() {
        policy["DefaultSearchProviderSuggestURL"] = json!(chosen.suggest_url);
    }
    tokio::fs::write(&policy_path, serde_json::to_vec_pretty(&policy)?).await?;

    tokio::fs::create_dir_all(&ext_dir).await?;
    let mut search_provider = json!({
        "name": chosen.name,
        "keyword": chosen.keyword,
        "search_url": chosen.url,
        "favicon_url": favicon,
        "encoding": "UTF-8",
        "is_default": true
    });
    if !chosen.suggest_url.is_empty() {
        search_provider["suggest_url"] = json!(chosen.suggest_url);
    }
    let manifest = json!({
        "manifest_version": 3,
        "name": "Enclave Search",
        "version": "1.0.0",
        "chrome_settings_overrides": {
            "search_provider": search_provider
        }
    });
    tokio::fs::write(ext_dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?).await?;
    Ok(Some(ext_dir))
}