import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFRESH_MARGIN_MS, RETRY_MS, credentialSource, describeCredentials, type AwsCredentialSpec } from "./aws_credentials.ts";
import { startFakeSts, type FakeSts } from "../../tests/support/fake_sts.ts";
import { until } from "../../tests/support/until.ts";

const ROLE = "arn:aws:iam::123456789012:role/grayboard";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.web-identity-token-secret.sig";
let dir: string;
let sts: FakeSts;
let clock: number;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-aws-creds-"));
  writeFileSync(join(dir, "token"), `${TOKEN}\n`);
  sts = startFakeSts();
  clock = 1_800_000_000_000;
  sts.now = () => clock;
  logs = [];
});
afterEach(() => {
  sts.stop();
  rmSync(dir, { recursive: true, force: true });
});

const spec = (over: Partial<Extract<AwsCredentialSpec, { kind: "web-identity" }>> = {}): AwsCredentialSpec =>
  ({ kind: "web-identity", roleArn: ROLE, tokenFile: join(dir, "token"), stsEndpoint: sts.endpoint, sessionName: "grayboard-test", ...over });
const source = (s = spec(), stsTimeoutMs?: number) => credentialSource(s, { now: () => clock, log: (l) => logs.push(l), ...(stsTimeoutMs ? { stsTimeoutMs } : {}) });

test("one exchange serves until five minutes before expiry, then the next get refreshes", async () => {
  const creds = source();
  const first = await creds.get();
  expect(first).toEqual({ ...sts.issued(1), expiration: clock + 3600_000 });
  expect(await creds.get()).toBe(first);
  clock += 3600_000 - REFRESH_MARGIN_MS - 1;
  expect(await creds.get()).toBe(first);
  expect(sts.requests).toHaveLength(1);
  clock += 2;
  expect(await creds.get()).toMatchObject(sts.issued(2));
  expect(sts.requests).toHaveLength(2);
});

test("concurrent gets share one exchange", async () => {
  const creds = source();
  const release = sts.hang();
  const gets = Array.from({ length: 8 }, () => creds.get());
  await until(() => sts.inflight === 1);
  release();
  const all = await Promise.all(gets);
  expect(new Set(all).size).toBe(1);
  expect(all[0]).toMatchObject(sts.issued(1));
  expect(sts.requests).toHaveLength(1);
});

test("the token goes in a form POST body, never the URL, and the token file is re-read at each exchange", async () => {
  const creds = source();
  await creds.get();
  const [req] = sts.requests;
  expect(req!.method).toBe("POST");
  expect(req!.contentType).toStartWith("application/x-www-form-urlencoded");
  expect(req!.url).not.toContain(TOKEN);
  expect(req!.url).not.toContain("web-identity-token");
  expect(new URL(req!.url).search).toBe("");
  expect(req!.form).toEqual({
    Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: ROLE, RoleSessionName: "grayboard-test",
    WebIdentityToken: TOKEN, DurationSeconds: "3600",
  });
  // The kubelet rotates the projected token.
  writeFileSync(join(dir, "token"), "rotated-token");
  clock += 3600_000;
  await creds.get();
  expect(sts.requests[1]!.form.WebIdentityToken).toBe("rotated-token");
});

test("a failed refresh serves the still-valid keys, logs once and backs off; once they expire it throws", async () => {
  const creds = source();
  const first = await creds.get();
  clock += 3600_000 - REFRESH_MARGIN_MS + 1;
  sts.refuse({ status: 400, code: "InvalidIdentityToken", message: "Token expired" });
  expect(await creds.get()).toBe(first);
  expect(sts.requests).toHaveLength(2);
  // Within the backoff, no call to STS.
  expect(await creds.get()).toBe(first);
  expect(sts.requests).toHaveLength(2);
  clock += RETRY_MS;
  expect(await creds.get()).toBe(first);
  expect(sts.requests).toHaveLength(3);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("InvalidIdentityToken");
  for (const secret of [TOKEN, first.secretAccessKey, first.sessionToken!]) expect(logs[0]).not.toContain(secret);
  clock = first.expiration!;
  await expect(creds.get()).rejects.toThrow(`STS AssumeRoleWithWebIdentity for ${ROLE}: HTTP 400 InvalidIdentityToken: Token expired`);
  // Recovery: the next success resets the streak.
  sts.refuse(null);
  expect(await creds.get()).toMatchObject(sts.issued(2));
});

test("STS's refusal names its code, message and the role, never the token", async () => {
  sts.refuse({ status: 403, code: "AccessDenied", message: "Not authorized to perform sts:AssumeRoleWithWebIdentity" });
  const err = await source().get().then(() => null, (e: Error) => e);
  expect(err!.message).toBe(`STS AssumeRoleWithWebIdentity for ${ROLE}: HTTP 403 AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity`);
  expect(err!.message).not.toContain(TOKEN);
  expect(err!.stack ?? "").not.toContain(TOKEN);
});

test("an answer without credentials is refused without quoting it (it may carry a secret)", async () => {
  const leaky = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>AKIDX</AccessKeyId><SecretAccessKey>LEAKED-SECRET</SecretAccessKey><SessionToken>LEAKED-TOKEN</SessionToken></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`),
  });
  try {
    const err = await source(spec({ stsEndpoint: `http://127.0.0.1:${leaky.port}/` })).get().then(() => null, (e: Error) => e);
    expect(err!.message).toBe(`STS AssumeRoleWithWebIdentity for ${ROLE}: HTTP 200 without the credentials it should carry`);
    for (const secret of ["LEAKED-SECRET", "LEAKED-TOKEN", TOKEN]) expect(err!.message).not.toContain(secret);
  } finally {
    void leaky.stop(true);
  }
});

test("an STS that doesn't answer is cut off at the deadline", async () => {
  const release = sts.hang();
  try {
    await expect(source(spec(), 100).get()).rejects.toThrow(`STS AssumeRoleWithWebIdentity for ${ROLE} at ${sts.endpoint}: no answer in 100 ms`);
  } finally {
    release();
  }
});

test("an unreadable or empty token file names the path, not the contents", async () => {
  await expect(source(spec({ tokenFile: join(dir, "absent") })).get()).rejects.toThrow(`cannot read AWS_WEB_IDENTITY_TOKEN_FILE ${join(dir, "absent")}: ENOENT`);
  writeFileSync(join(dir, "token"), "\n");
  await expect(source().get()).rejects.toThrow(`AWS_WEB_IDENTITY_TOKEN_FILE ${join(dir, "token")} is empty`);
  expect(sts.requests).toHaveLength(0);
});

test("static keys are served as given, without expiry, and described without a key", async () => {
  const s: AwsCredentialSpec = { kind: "static", accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret" };
  expect(await credentialSource(s).get()).toEqual({ accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret" });
  expect(await credentialSource({ ...s, sessionToken: "st" }).get()).toEqual({ accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret", sessionToken: "st" });
  expect(describeCredentials(s)).toBe("static keys");
  expect(describeCredentials(spec())).toBe(`web identity, role ${ROLE}`);
});
