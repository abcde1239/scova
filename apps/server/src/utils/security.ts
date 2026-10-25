import { createHash, createHmac } from "node:crypto";

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const csrfForSession = (token: string) =>
  createHmac("sha256", token).update("scova.csrf.v1").digest("base64url");

export const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
