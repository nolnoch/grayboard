// #1418: the server image is the signed release's own binary, published after the release by a job that can't reach
// the signing key, with every action and the base pinned.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("the image job publishes the released binaries, after the release, without the signing environment", () => {
  const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as any;
  const job = release.jobs.image;
  expect(job.needs).toBe("release");
  expect(job.environment).toBeUndefined();
  expect(job.permissions).toEqual({ contents: "read", packages: "write", "id-token": "write", attestations: "write", "artifact-metadata": "write" });
  const text = JSON.stringify(job);
  expect(text).not.toContain("RELEASE_SIGNING_KEY");
  const step = (name: string) => {
    const found = job.steps.find((s: any) => s.name === name);
    expect(found).toBeDefined();
    return found;
  };
  // The sums are checked against their signature and the committed key, both server lines are required, and each
  // architecture's binary goes into its own context directory.
  const stage = step("Check the binaries against the release and stage the context").run as string;
  expect(stage).toContain("-p SHA256SUMS -p SHA256SUMS.sig");
  expect(stage).toContain('openssl dgst -sha256 -verify "$pub" -signature "$RUNNER_TEMP/sums.der" dist/SHA256SUMS');
  expect(stage).toContain('[ "$(wc -l < "$RUNNER_TEMP/server.sums")" -eq 2 ]');
  expect(stage).toContain('(cd dist && sha256sum -c "$RUNNER_TEMP/server.sums")');
  expect(stage).not.toMatch(/\|\|\s*true/);
  expect(stage).toContain("install -m 0755 dist/grayboard-server-linux-x64 image/amd64/grayboard-server");
  expect(stage).toContain("install -m 0755 dist/grayboard-server-linux-arm64 image/arm64/grayboard-server");
  // A loaded build's smoke run gates the push, and compares the version with the tag.
  const names = job.steps.map((s: any) => s.name ?? s.uses);
  const order = ["Check the binaries against the release and stage the context", "Build for this runner", "Smoke-test the image", "Build and push", "Attest build provenance", "Tag the release"];
  const at = order.map(n => names.indexOf(n));
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
  expect(step("Build for this runner").with).toMatchObject({ platforms: "linux/amd64", load: true });
  expect(step("Smoke-test the image").run).toContain('[ "$got" = "${TAG#v}" ]');
  // Pushed by digest with no tag; attested; then the tag names that digest and is checked to resolve to it.
  const push = step("Build and push").with;
  expect(push.tags).toBeUndefined();
  expect(push.push).toBeUndefined();
  expect(push.outputs).toContain("push-by-digest=true");
  expect(step("Attest build provenance").with).toMatchObject({ "subject-digest": "${{ steps.push.outputs.digest }}", "push-to-registry": true });
  const tag = step("Tag the release");
  expect(tag.env.DIGEST).toBe("${{ steps.push.outputs.digest }}");
  expect(tag.run).toContain('docker buildx imagetools create -t "$IMAGE:$TAG" "$IMAGE@$DIGEST"');
  expect(tag.run).toContain('[ "$got" = "$DIGEST" ]');
  for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
});

test("the Dockerfile copies one binary onto a digest-pinned base and runs it unprivileged", () => {
  const lines = read("deploy/Dockerfile").split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
  // One stage: the only FROM is the pinned base.
  const froms = lines.filter(l => /^\s*FROM\b/i.test(l));
  expect(froms).toHaveLength(1);
  expect(froms[0]).toMatch(/^FROM gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[0-9a-f]{64}$/);
  // COPY only: a foreign platform builds without emulation, and nothing but the release's bytes goes in.
  expect(lines.filter(l => /^\s*(RUN|ADD)\b/i.test(l))).toEqual([]);
  expect(lines.filter(l => /^\s*COPY\b/i.test(l))).toEqual(["COPY ${TARGETARCH}/grayboard-server /usr/local/bin/grayboard-server"]);
  // Numeric, so Kubernetes' runAsNonRoot can check it; the last USER is the one that runs.
  expect(lines.filter(l => /^\s*USER\b/i.test(l))).toEqual(["USER 65532:65532"]);
  expect(lines.at(-1)).toBe('ENTRYPOINT ["/usr/local/bin/grayboard-server"]');
});
