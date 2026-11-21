// A loopback S3 for the S3 blob store's tests (#1509): path-style PUT/GET/HEAD/DELETE on /<bucket>/<key>, answering
// errors with AWS's XML shape (404 NoSuchKey, 403 AccessDenied). It doesn't check SigV4 signatures, only who signed:
// each request's access key id (from the Authorization header) and x-amz-security-token are recorded, and a request
// whose pair isn't one `allow()` named is refused 403, so a test proves the store sent the credentials it was given.
// A real S3-compatible server proves the signing (the smoke in the #1509 report).

export type S3Request = { method: string; key: string; accessKeyId: string | null; sessionToken: string | null };
export type FakeS3 = {
  endpoint: string;
  bucket: string;
  // The stored objects, by key (without the bucket).
  objects: Map<string, Uint8Array<ArrayBuffer>>;
  requests: S3Request[];
  // Credentials the fake accepts: an access key id, with the session token it must carry (null: none).
  allow(accessKeyId: string, sessionToken?: string | null): void;
  // The next requests of `method` (all methods when absent) get this status and code, until reset with null.
  fail(f: { method?: string; status: number; code: string } | null): void;
  // The next request of `method` hangs until the returned release is called (stop() releases it too).
  hang(method: string): () => void;
  stop(): void;
};

const AUTH = /Credential=([^/,\s]+)\//;

function errorXml(status: number, code: string, key: string): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${code === "NoSuchKey" ? "The specified key does not exist." : "Access Denied"}</Message><Key>${key}</Key><RequestId>FAKE</RequestId></Error>`;
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

export function startFakeS3(bucket = "example-bucket"): FakeS3 {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const requests: S3Request[] = [];
  const allowed = new Map<string, string | null>();
  let failure: { method?: string; status: number; code: string } | null = null;
  const hangs = new Map<string, Promise<void>>();
  const releases = new Set<() => void>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      const prefix = `/${bucket}/`;
      const key = path.startsWith(prefix) ? path.slice(prefix.length) : "";
      const accessKeyId = AUTH.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
      const sessionToken = req.headers.get("x-amz-security-token");
      requests.push({ method: req.method, key, accessKeyId, sessionToken });
      const hang = hangs.get(req.method);
      if (hang) {
        hangs.delete(req.method);
        await hang;
      }
      if (!path.startsWith(prefix)) return errorXml(404, "NoSuchBucket", key);
      if (accessKeyId === null || !allowed.has(accessKeyId) || allowed.get(accessKeyId) !== sessionToken) {
        return req.method === "HEAD" ? new Response(null, { status: 403 }) : errorXml(403, "AccessDenied", key);
      }
      if (failure && (!failure.method || failure.method === req.method)) {
        return req.method === "HEAD" ? new Response(null, { status: failure.status }) : errorXml(failure.status, failure.code, key);
      }
      switch (req.method) {
        case "PUT":
          objects.set(key, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { status: 200, headers: { etag: '"fake"' } });
        case "GET":
        case "HEAD": {
          const data = objects.get(key);
          if (!data) return req.method === "HEAD" ? new Response(null, { status: 404 }) : errorXml(404, "NoSuchKey", key);
          return new Response(req.method === "HEAD" ? null : data, {
            status: 200,
            headers: { "content-length": String(data.length), "content-type": "application/octet-stream", etag: '"fake"', "last-modified": new Date(0).toUTCString() },
          });
        }
        case "DELETE":
          objects.delete(key);
          return new Response(null, { status: 204 });
        default:
          return errorXml(405, "MethodNotAllowed", key);
      }
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    bucket,
    objects,
    requests,
    allow(accessKeyId, sessionToken = null) {
      allowed.set(accessKeyId, sessionToken);
    },
    fail(f) {
      failure = f;
    },
    hang(method) {
      let release!: () => void;
      hangs.set(method, new Promise<void>((r) => { release = r; }));
      releases.add(release);
      return release;
    },
    stop() {
      for (const r of releases) r();
      void server.stop(true);
    },
  };
}
