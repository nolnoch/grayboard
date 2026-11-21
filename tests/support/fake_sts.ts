// A loopback STS for the S3 credential provider's tests (#1509): AssumeRoleWithWebIdentity as a form POST, answering
// AWS's XML. Each exchange issues fresh keys (AKID<n>, SECRET<n>, TOKEN<n>) expiring `expiresInMs` after the fake's
// clock, records the request's URL and form, and can refuse with an STS error or hang until released.

export type StsRequest = { method: string; url: string; contentType: string | null; form: Record<string, string> };
export type FakeSts = {
  endpoint: string;
  requests: StsRequest[];
  // The keys of the n-th exchange (1-based).
  issued(n: number): { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  // How long issued keys last, from the fake's clock (default Date.now).
  expiresInMs: number;
  now: () => number;
  // The next exchanges answer this HTTP status with this STS error code and message, until reset with null.
  refuse(r: { status: number; code: string; message: string } | null): void;
  // The next exchange hangs until the returned release is called (stop() releases it too).
  hang(): () => void;
  // Exchanges in flight right now.
  inflight: number;
  stop(): void;
};

export function startFakeSts(): FakeSts {
  let refusal: { status: number; code: string; message: string } | null = null;
  let hung: Promise<void> | undefined;
  const releases = new Set<() => void>();
  let n = 0;
  const issued = (i: number) => ({ accessKeyId: `AKID${i}`, secretAccessKey: `SECRET${i}`, sessionToken: `TOKEN${i}` });

  const fake: FakeSts = {
    endpoint: "",
    requests: [],
    issued,
    expiresInMs: 3600_000,
    now: Date.now,
    inflight: 0,
    refuse(r) {
      refusal = r;
    },
    hang() {
      let release!: () => void;
      hung = new Promise<void>((r) => { release = r; });
      releases.add(release);
      return release;
    },
    stop() {
      for (const r of releases) r();
      void server.stop(true);
    },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const form = Object.fromEntries(new URLSearchParams(text));
      fake.requests.push({ method: req.method, url: req.url, contentType: req.headers.get("content-type"), form });
      fake.inflight++;
      try {
        if (hung) {
          const h = hung;
          hung = undefined;
          await h;
        }
        if (refusal) {
          return new Response(
            `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${refusal.code}</Code><Message>${refusal.message}</Message></Error><RequestId>fake</RequestId></ErrorResponse>`,
            { status: refusal.status, headers: { "content-type": "text/xml" } },
          );
        }
        const keys = issued(++n);
        const expiration = new Date(fake.now() + fake.expiresInMs).toISOString();
        return new Response(
          `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult>` +
            `<SubjectFromWebIdentityToken>system:serviceaccount:grayboard:grayboard</SubjectFromWebIdentityToken>` +
            `<AssumedRoleUser><Arn>${form.RoleArn}/${form.RoleSessionName}</Arn><AssumedRoleId>AROAFAKE:${form.RoleSessionName}</AssumedRoleId></AssumedRoleUser>` +
            `<Credentials><AccessKeyId>${keys.accessKeyId}</AccessKeyId><SecretAccessKey>${keys.secretAccessKey}</SecretAccessKey>` +
            `<SessionToken>${keys.sessionToken}</SessionToken><Expiration>${expiration}</Expiration></Credentials>` +
            `<Provider>arn:aws:iam::123456789012:oidc-provider/oidc.eks.example.com</Provider></AssumeRoleWithWebIdentityResult>` +
            `<ResponseMetadata><RequestId>fake</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`,
          { status: 200, headers: { "content-type": "text/xml" } },
        );
      } finally {
        fake.inflight--;
      }
    },
  });
  fake.endpoint = `http://127.0.0.1:${server.port}/`;
  return fake;
}
