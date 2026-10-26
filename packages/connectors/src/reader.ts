import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { createSafeHttpClient, normalizeUrl, positiveLimit, withDeadline } from "./http.ts";
import type { SafeHttpClient } from "./http.ts";
import { ConnectorError } from "./types.ts";
import type { PageReader } from "./types.ts";

export const EXTRACTION_VERSION = "readability-0.6.0/scova-text-v1";

export function pageFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createPageReader(
  options: { http?: SafeHttpClient; maxTextChars?: number } = {},
): PageReader {
  const http = options.http ?? createSafeHttpClient();
  const maxText = positiveLimit(options.maxTextChars ?? 100_000, 200_000, "正文长度");
  const origins = new Map<string, Promise<void>>();
  return {
    read(originalUrl, context = {}) {
      const url = normalizeUrl(originalUrl);
      const origin = new URL(url).origin;
      const previous = origins.get(origin) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      origins.set(origin, tail);
      const result = withDeadline(
        Math.min(context.timeoutMs ?? 15_000, 15_000),
        context.signal,
        async (signal) => {
          await previous;
          if (signal.aborted) throw signal.reason;
          await context.beforeAttempt?.("read");
          if (signal.aborted) throw signal.reason;
          const response = await http.request(url, {
            signal,
            maxBytes: 2 * 1024 * 1024,
            maxRedirects: 3,
          });
          if (response.status < 200 || response.status >= 300)
            throw new ConnectorError(
              "http",
              "网页采集失败",
              response.status === 429 || response.status >= 500,
              response.status,
            );
          const contentType = response.headers["content-type"] ?? "";
          if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType))
            throw new ConnectorError("invalid_response", "网页不是 HTML 正文");
          const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
          if (charset && !/^utf-?8$/i.test(charset))
            throw new ConnectorError("invalid_response", "网页字符编码不支持");
          const dom = new JSDOM(response.body, { url: response.url });
          try {
            const document = dom.window.document;
            if (document.getElementsByTagName("*").length > 20_000)
              throw new ConnectorError("extraction_failed", "网页节点数超过提取限制");
            const contentMeta = [...document.querySelectorAll("meta[http-equiv]")].find(
              (meta) => meta.getAttribute("http-equiv")?.toLowerCase() === "content-type",
            );
            const declared =
              document.querySelector("meta[charset]")?.getAttribute("charset") ??
              contentMeta?.getAttribute("content")?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
            if (declared && !/^utf-?8$/i.test(declared))
              throw new ConnectorError("invalid_response", "网页声明的字符编码不支持");
            document
              .querySelectorAll("script,style,iframe,object,embed,form,noscript")
              .forEach((node) => node.remove());
            const article = new Readability(document, {
              charThreshold: 0,
              maxElemsToParse: 20_000,
            }).parse();
            const fullText = article?.textContent?.replace(/\s+/g, " ").trim();
            if (!fullText) throw new ConnectorError("extraction_failed", "网页没有可提取正文");
            const text = fullText.slice(0, maxText);
            return {
              kind: "read_page" as const,
              mode: "live" as const,
              originalUrl,
              fetchedUrl: response.url,
              url: normalizeUrl(response.url),
              title: article?.title?.trim() ?? "",
              text,
              contentHash: pageFingerprint(text),
              extractionVersion: EXTRACTION_VERSION,
              collectedAt: new Date().toISOString(),
              truncated: fullText.length > maxText,
              untrusted: true as const,
            };
          } finally {
            dom.window.close();
          }
        },
      );
      return result.finally(() => {
        release();
        if (origins.get(origin) === tail)
          void tail.then(() => {
            if (origins.get(origin) === tail) origins.delete(origin);
          });
      });
    },
  };
}
