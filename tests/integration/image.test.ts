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
  // The bytes are checked against the published, signed sums before they go in.
  const stage = job.steps.find((s: any) => s.name === "Check the binaries against the release and stage the context");
  expect(stage.run).toContain("-p SHA256SUMS");
  expect(stage.run).toContain("sha256sum -c -");
  // A smoke run gates the push.
  const names = job.steps.map((s: any) => s.name ?? s.uses);
  expect(names.indexOf("Smoke-test the image")).toBeLessThan(names.indexOf("Build and push"));
  expect(job.steps.find((s: any) => s.name === "Build and push").with.tags).toBe("${{ env.IMAGE }}:${{ github.ref_name }}");
  expect(job.steps.find((s: any) => s.name === "Attest build provenance").with["push-to-registry"]).toBe(true);
  for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
});

test("the Dockerfile copies one binary onto a digest-pinned base and runs it unprivileged", () => {
  const lines = read("deploy/Dockerfile").split("\n").filter(l => l.trim() && !l.startsWith("#"));
  expect(lines[0]).toMatch(/^FROM gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[0-9a-f]{64}$/);
  // COPY only: a foreign platform builds without emulation, and nothing but the release's bytes goes in.
  expect(lines.filter(l => /^(RUN|ADD)\b/.test(l))).toEqual([]);
  expect(lines).toContain("COPY ${TARGETARCH}/grayboard-server /usr/local/bin/grayboard-server");
  expect(lines).toContain("USER nonroot");
  expect(lines.at(-1)).toBe('ENTRYPOINT ["/usr/local/bin/grayboard-server"]');
});
