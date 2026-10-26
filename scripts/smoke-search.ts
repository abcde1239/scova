import {
  createPageReader,
  createSearxngSearch,
  ConnectorError,
} from "../packages/connectors/src/index.ts";

if (!process.argv.includes("--live")) {
  console.log(
    "NOT RUN: use --live to query the configured SearxNG instance and its upstream engines.",
  );
} else {
  const counts = { search: 0, read: 0, model: 0 };
  const context = {
    signal: AbortSignal.timeout(30_000),
    timeoutMs: 15_000,
    beforeAttempt(kind: keyof typeof counts) {
      if (++counts[kind] > 1)
        throw new ConnectorError("budget_exceeded", "Smoke allows one attempt per tool");
    },
  };
  try {
    const search = createSearxngSearch({
      baseUrl: process.env.SEARXNG_BASE_URL,
      maxAttempts: 1,
      maxResults: 5,
    });
    const result = await search.search(
      process.argv.includes("--chinese") ? "中国政府网 人工智能" : "IANA example domains",
      context,
    );
    if (result.results.length === 0)
      throw new ConnectorError("invalid_response", "Smoke search returned no sources");
    console.log(
      JSON.stringify({
        status: result.coverage.complete ? "search_passed" : "search_partial",
        provider: result.provider,
        searchedAt: result.searchedAt,
        coverage: result.coverage,
        results: result.results,
        counts,
      }),
    );
    if (process.argv.includes("--read")) {
      const page = await createPageReader().read(result.results[0].originalUrl, context);
      if (!page.text.trim())
        throw new ConnectorError("extraction_failed", "No original text was collected");
      console.log(
        JSON.stringify({
          status: page.truncated ? "read_partial" : "read_passed",
          originalUrl: page.originalUrl,
          fetchedUrl: page.fetchedUrl,
          url: page.url,
          collectedAt: page.collectedAt,
          contentHash: page.contentHash,
          extractionVersion: page.extractionVersion,
          truncated: page.truncated,
          textSample: page.text.slice(0, 400),
          counts,
        }),
      );
    } else console.log("NOT RUN: webpage reading and model generation (search-only smoke).");
  } catch (error) {
    console.error(
      error instanceof ConnectorError
        ? `FAILED: ${error.code}: ${error.message} (status=${error.status ?? "none"})`
        : "FAILED: search verification failed",
    );
    process.exitCode = 1;
  }
}
