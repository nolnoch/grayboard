// A response body read with a byte cap, for fetches whose peer isn't trusted to bound it: a release download
// (src/cli/update.ts) and the OIDC provider's discovery, token and userinfo answers (src/server/idp_oidc.ts).

/** The body, or null once it's over `max` bytes (stated or streamed), having stopped reading. */
export async function cappedBody(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get("content-length") ?? NaN) > max) {
    await res.body?.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
