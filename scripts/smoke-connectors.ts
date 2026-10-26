import { createConnectorBundle, createPageReader } from "../packages/connectors/src/index.ts";
import { ConnectorError, type ConnectorKind } from "../packages/connectors/src/types.ts";

const live = process.argv.includes("--live");
const readerOnly = process.argv.includes("--reader-only");
const apiKey = process.env.MODEL_API_KEY;
const model = process.env.MODEL_NAME;
const tavilyApiKey = process.env.TAVILY_API_KEY;
const searchProvider = process.argv.includes("--provider=tavily") ? "tavily" : "searxng";

if (!live && !readerOnly) {
  console.log(
    "NOT RUN: use --live to opt in to search + model calls, or --reader-only for a public page.",
  );
} else if (live && (!apiKey || !model || (searchProvider === "tavily" && !tavilyApiKey))) {
  console.log(
    `NOT RUN: live ${searchProvider} + model smoke requires MODEL_API_KEY and MODEL_NAME${searchProvider === "tavily" ? ", plus TAVILY_API_KEY" : ""}. No demo fallback.`,
  );
} else {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const counts = { search: 0, model: 0, read: 0 };
  const context = {
    signal: controller.signal,
    timeoutMs: 15_000,
    beforeAttempt(kind: ConnectorKind) {
      counts[kind]++;
      if (counts[kind] > 1)
        throw new ConnectorError("budget_exceeded", "Smoke allows one attempt per tool");
    },
  };
  try {
    if (readerOnly) {
      const page = await createPageReader().read(
        "https://www.iana.org/help/example-domains",
        context,
      );
      if (!page.text.includes("example.com"))
        throw new Error("Public page did not contain the expected original text");
      console.log(
        JSON.stringify({
          status: page.truncated ? "reader_partial" : "reader_passed",
          providerSmoke: "NOT RUN",
          url: page.url,
          hash: page.contentHash,
          truncated: page.truncated,
          counts,
        }),
      );
    } else {
      const connectors = createConnectorBundle({
        searchProvider,
        searxngBaseUrl: process.env.SEARXNG_BASE_URL,
        tavilyApiKey,
        modelApiKey: apiKey,
        model,
        modelBaseUrl: process.env.MODEL_BASE_URL,
      });
      if (connectors.mode !== "live") throw new Error("Live smoke must select live services");
      const search = await connectors.search.search(
        "site:iana.org/help/example-domains example domains",
        context,
      );
      const candidate = search.results.find(
        (result) => new URL(result.url).hostname === "www.iana.org",
      );
      if (!candidate)
        throw new Error("Search did not return an IANA source; coverage is insufficient");
      const page = await connectors.reader.read(candidate.originalUrl, context);
      const result = await connectors.model.generateStructured<{ quote: string }>(
        {
          prompt:
            "Extract one exact nonempty quote about example domains from the supplied source. Do not modify its text.",
          untrustedSources: [{ url: page.url, text: page.text.slice(0, 5_000) }],
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { quote: { type: "string", minLength: 10 } },
            required: ["quote"],
          },
          maxInputTokens: 12_000,
          maxOutputTokens: 256,
        },
        context,
      );
      if (!page.text.includes(result.data.quote))
        throw new Error("Model quote is not present in the collected original text");
      console.log(
        JSON.stringify({
          status: search.coverage.complete && !page.truncated ? "live_passed" : "live_partial",
          coverage: search.coverage,
          truncated: page.truncated,
          originalUrl: page.originalUrl,
          fetchedUrl: page.fetchedUrl,
          collectedAt: page.collectedAt,
          url: page.url,
          hash: page.contentHash,
          extractionVersion: page.extractionVersion,
          usage: result.usage,
          counts,
        }),
      );
    }
  } catch (error) {
    console.error(
      error instanceof ConnectorError
        ? `FAILED: ${error.code} (status=${error.status ?? "none"})`
        : "FAILED: source or quote verification failed",
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
