// A service's run token as a launcher mints it (#270 step 3, #1243): an admin
// creates the service and a credential through the admin routes, and the
// launcher mints with client_credentials (Basic auth, no browser). `env` is
// what a launcher sets for a hosted-core harness's static mode.
import { expect } from "bun:test";
import type { TestServer } from "./server.ts";

export type ServiceRun = {
  token: string;
  clientId: string;
  secret: string;
  /** GRAYBOARD_AUTH, GRAYBOARD_ISSUER, GRAYBOARD_RUN_TOKEN, GRAYBOARD_PRINCIPAL. */
  env: Record<string, string>;
  /** Mints another run token with the same credential. */
  mint(): Promise<string>;
  /** Revokes the credential (admin route): every run token it minted stops working and its sessions end. */
  revoke(): Promise<void>;
};

const basic = (id: string, secret: string) => `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;

/**
 * `srv` must list `admin` in its admins (`hostedServer({ admins: [admin] })`). The service is created on first use
 * (owned by `owner`, who is signed in for it); `issuer` is the pin `env` carries (the server's public URL by default).
 */
export async function serviceRun(srv: TestServer & { issuer?: string }, o: { service?: string; admin?: string; owner?: string; source?: string; tokenSeconds?: number; issuer?: string } = {}): Promise<ServiceRun> {
  const service = o.service ?? "ingest", admin = o.admin ?? "root@example.com", owner = o.owner ?? "alice@example.com";
  const root = await srv.login(admin);
  await srv.login(owner);
  const listed = await srv.api(root, "GET", "/api/admin/services");
  const exists = JSON.stringify(listed.body).includes(`"${service}"`);
  if (!exists) {
    const created = await srv.api(root, "POST", "/api/admin/services", { name: service, owners: [owner] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  }
  const c = await srv.api(root, "POST", "/api/admin/services/credentials", { service, ...(o.source ? { source: o.source } : {}), ...(o.tokenSeconds ? { token_seconds: o.tokenSeconds } : {}) });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const clientId = c.body.client_id as string, secret = c.body.client_secret as string;
  const mint = async () => {
    const r = await fetch(`${srv.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(clientId, secret) }, body: new URLSearchParams({ grant_type: "client_credentials" }) });
    const body = await r.json() as { access_token?: string };
    expect(r.status, JSON.stringify(body)).toBe(200);
    return body.access_token!;
  };
  const token = await mint();
  const issuer = o.issuer ?? srv.issuer ?? srv.base;
  return {
    token, clientId, secret, mint,
    env: { GRAYBOARD_AUTH: "static", GRAYBOARD_ISSUER: issuer, GRAYBOARD_RUN_TOKEN: token, GRAYBOARD_PRINCIPAL: service },
    revoke: async () => {
      const r = await srv.api(root, "POST", "/api/admin/services/credentials/revoke", { client_id: clientId });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    },
  };
}
