import type { Client } from "@modelcontextprotocol/client";
// `key` is the `_meta` key the connecting client's source mapping reads (#414), or its
// delivery declaration's (#429), whose value is an object.
export async function withSessionMeta(request: Request, key: string, value: unknown): Promise<Request> {
  if (request.method !== "POST") return request;
  const body = await request.clone().json() as { params?: Record<string, unknown> };
  body.params = { ...body.params, _meta: { ...(body.params?._meta as Record<string, unknown> | undefined), [key]: value } };
  return new Request(request, { body: JSON.stringify(body) });
}
export async function bindFixture(client: Client, name: string) {
  const state = await client.callTool({ name: "whoami", arguments: {} });
  const content = state.content?.[0];
  if (content?.type !== "text") throw new Error("missing whoami content");
  if (JSON.parse(content.text).name) return;
  const bound = await client.callTool({ name: "bind", arguments: { name, create: true } });
  if (bound.isError && !JSON.stringify(bound).includes("already in use")) throw new Error(JSON.stringify(bound));
}
