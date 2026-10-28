import { readFileSync } from "node:fs";

const document = readFileSync(new URL("./fixtures/opencode-client.json", import.meta.url), "utf8");
const clientID = "https://opencode.ai/oauth/opencode/client.json";
export function savedClientMetadata(url: URL): string {
  if (url.href !== clientID) throw new Error("Unexpected fixture CIMD URL");
  return document;
}
