// A local stand-in for GitHub's release hosting, served at one origin with
// GitHub's paths (what GRAYBOARD_RELEASES_URL points install.sh and
// `grayboard update` at): the API's release responses with per-asset sha256
// digests (what both verifiers check against, #173), the web's latest-release
// redirect, and asset downloads. The assets are real binaries on disk, and a
// served digest is the file's own — unless `digests` overrides it, for a test
// that needs the release to lie.
export class ReleaseServer {
  /** Every request's method and path, in order. */
  readonly requests: string[] = [];
  readonly server;

  constructor(
    readonly repo: string,
    readonly latest: string,
    private readonly assets: Record<string, Record<string, string>>,
    private readonly digests?: Record<string, Record<string, string>>,
  ) {
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
        digest: this.digests?.[tag]?.[name] ?? `sha256:${new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")}`,
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
