// A local stand-in for GitHub's release hosting, served at one origin with
// GitHub's paths (what GRAYBOARD_RELEASES_URL points install.sh and
// `grayboard update` at): the API's latest release, the web's latest-release
// redirect, and asset downloads. The assets are real binaries on disk.
export class ReleaseServer {
  /** Every request's method and path, in order. */
  readonly requests: string[] = [];
  readonly server;

  constructor(
    readonly repo: string,
    readonly latest: string,
    private readonly assets: Record<string, Record<string, string>>,
  ) {
    this.server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        this.requests.push(`${req.method} ${path}`);
        if (path === `/repos/${repo}/releases/latest`) return Response.json({ tag_name: this.latest });
        if (path === `/${repo}/releases/latest`) return Response.redirect(`${this.url}/${repo}/releases/tag/${this.latest}`, 302);
        if (path === `/${repo}/releases/tag/${this.latest}`) return new Response("release page");
        const m = new RegExp(`^/${repo}/releases/download/([^/]+)/([^/]+)$`).exec(path);
        const file = m && this.assets[m[1]!]?.[m[2]!];
        if (file) return new Response(Bun.file(file));
        return new Response("Not Found", { status: 404 });
      },
    });
  }

  get url(): string {
    return `http://localhost:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}
