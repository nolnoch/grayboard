// The CLI compiled from this tree: the "build under test" the installer tests
// install and update to. `version` replaces package.json's in the binary, so
// a build of this tree can stand in for an older release. Compiled in a child
// whose cwd is a temp dir that's removed after, because bun build --compile
// leaves a runtime copy in its cwd (#169).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

export async function buildCli(outfile: string, version?: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "grayboard-build-"));
  try {
    const p = Bun.spawn([process.execPath, import.meta.path, outfile, ...(version ? [version] : [])], { cwd, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if (code !== 0) throw new Error(`building ${outfile}: exit ${code}\n${out}${err}`);
    return outfile;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [outfile, version] = process.argv.slice(2);
  const r = await Bun.build({
    entrypoints: [join(ROOT, "src", "cli", "main.ts")],
    compile: { outfile: outfile! },
    plugins: version
      ? [{
          name: "version",
          setup: (b) => {
            b.onLoad({ filter: /[\\/]package\.json$/ }, async (a) => ({ contents: JSON.stringify({ ...(await Bun.file(a.path).json()), version }), loader: "json" }));
          },
        }]
      : [],
  });
  if (!r.success) {
    console.error(r.logs.join("\n"));
    process.exit(1);
  }
}
