// A local stand-in for GitHub's release hosting, served at one origin with
// GitHub's paths (what GRAYBOARD_RELEASES_URL points install.sh and
// `grayboard update` at): the API's release responses with per-asset sha256
// digests (what both verifiers check against, #173), the web's latest-release
// redirect, and asset downloads. The assets are real binaries on disk, and a
// served digest is the file's own — unless `digests` overrides it, for a test
// that needs the release to lie. Each tag also serves SHA256SUMS and
// SHA256SUMS.sig over its assets, signed by test key a (#162); `signed`
// replaces either file for a tag (null: not served).
import { signSums } from "./release_keys.ts";

export type SignedOverride = { sums?: string | null; sig?: string | null };

export class ReleaseServer {
  /** Every request's method and path, in order. */
  readonly requests: string[] = [];
  readonly server;
  private readonly signed: Record<string, Record<string, string | null>> = {};

  constructor(
    readonly repo: string,
    readonly latest: string,
    private readonly assets: Record<string, Record<string, string>>,
    private readonly opts: { digests?: Record<string, Record<string, string>>; signed?: Record<string, SignedOverride> } = {},
  ) {
    for (const [tag, files] of Object.entries(assets)) {
      const { sums, sig } = signSums(tag, files);
      const o = opts.signed?.[tag] ?? {};
      this.signed[tag] = { "SHA256SUMS": o.sums === undefined ? sums : o.sums, "SHA256SUMS.sig": o.sig === undefined ? sig : o.sig };
    }
    this.server = Bun.serve({
      port: 0,
      fetch: (req) => this.serve(req),
    });
  }

  private async serve(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    this.requests.push(`${req.method} ${path}`);
    if (path === `/repos/${this.repo}/releases/latest`) return this.releaseJson(this.latest);
    const tags = new RegExp(`^/repos/${this.repo}/releases/tags/([^/]+)$`).exec(path);
    if (tags) return this.releaseJson(decodeURIComponent(tags[1]!));
    if (path === `/${this.repo}/releases/latest`) return Response.redirect(`${this.url}/${this.repo}/releases/tag/${this.latest}`, 302);
    if (path === `/${this.repo}/releases/tag/${this.latest}`) return new Response("release page");
    const m = new RegExp(`^/${this.repo}/releases/download/([^/]+)/([^/]+)$`).exec(path);
    const text = m ? this.signed[m[1]!]?.[m[2]!] : undefined;
    if (text != null) return new Response(text);
    const file = m && this.assets[m[1]!]?.[m[2]!];
    if (file) return new Response(Bun.file(file));
    return new Response("Not Found", { status: 404 });
  }

  /** GitHub's release shape for `tag`: the tag and every served asset with its digest. */
  private async releaseJson(tag: string): Promise<Response> {
    const served = this.assets[tag];
    if (!served) return new Response("Not Found", { status: 404 });
    const assets = await Promise.all(
      Object.entries(served).map(async ([name, file]) => ({
        name,
        size: Bun.file(file).size,
        digest: this.opts.digests?.[tag]?.[name] ?? `sha256:${new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")}`,
      })),
    );
    // Pretty-printed, like api.github.com serves: hand-rolled parsing in
    // install.sh must survive GitHub's real shape, not just compact JSON (#173).
    return new Response(JSON.stringify({ tag_name: tag, assets }, null, 2), {
      headers: { "content-type": "application/json;charset=utf-8" },
    });
  }

  get url(): string {
    return `http://localhost:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}
