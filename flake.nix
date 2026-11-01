{
  description = "grayboard — durable coordination bus for coding agents (boards, claims, DMs)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          lib = pkgs.lib;

          # Only what bun reads at install/build time: manifests, lockfile,
          # sources. src/cli/adapters.ts is a build-time macro that reads
          # adapters/<harness>/grayboard.ts, so adapters/ must be present.
          src = lib.cleanSourceWith {
            src = self;
            filter =
              path: type:
              let
                rel = lib.removePrefix (self.outPath + "/") (toString path);
              in
              if type == "directory" then
                !builtins.elem rel [
                  ".git"
                  ".direnv"
                  ".e2e-cache"
                  ".e2e-runs"
                  ".github"
                  ".claude"
                  "node_modules"
                  "dist"
                  "docs"
                  "tests"
                  "scripts"
                ]
              else
                builtins.elem rel [
                  "package.json"
                  "bun.lock"
                  "tsconfig.json"
                  "LICENSE"
                ]
                || lib.hasPrefix "src/" rel
                || lib.hasPrefix "adapters/" rel;
          };

          # Fixed-output deps: `bun install` from the lockfile (the only step
          # with network). $out *is* node_modules.
          bunDeps = pkgs.stdenv.mkDerivation {
            pname = "grayboard-bun-deps";
            inherit version src;
            nativeBuildInputs = [ pkgs.bun ];
            buildPhase = ''
              export HOME="$TMPDIR" XDG_CACHE_HOME="$TMPDIR/cache"
              export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache" BUN_CONFIG_TELEMETRY=false
              bun install --frozen-lockfile --production --ignore-scripts
            '';
            installPhase = ''
              rm -rf node_modules/.bin
              cp -R node_modules "$out"
            '';
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-Nt4Dg2vUdX6uTbOnL5yMzRUv4Rp0hHF4JtNk57+a1co=";
          };
        in
        rec {
          grayboard = pkgs.stdenv.mkDerivation {
            pname = "grayboard";
            inherit version src;
            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;

            buildPhase = ''
              export HOME="$TMPDIR" XDG_CACHE_HOME="$TMPDIR/cache"
              export BUN_CONFIG_TELEMETRY=false
              cp -RL "${bunDeps}" ./node_modules
              chmod -R u+w node_modules
              mkdir -p dist
              bun build --compile src/cli/main.ts --outfile "$PWD/dist/grayboard"
              bun build --compile src/server/main.ts --outfile "$PWD/dist/grayboard-server"
            '';
            installPhase = ''
              install -Dm755 dist/grayboard "$out/bin/grayboard"
              install -Dm755 dist/grayboard-server "$out/bin/grayboard-server"
            '';

            # bun --compile appends its payload after the ELF sections.
            dontStrip = true;

            passthru = { inherit bunDeps; };

            meta = {
              description = "Durable coordination bus for coding agents (boards, claims, DMs)";
              homepage = "https://github.com/nolnoch/grayboard";
              license = lib.licenses.mit;
              mainProgram = "grayboard";
              platforms = systems;
            };
          };
          default = grayboard;
        }
      );

      apps = forAllSystems (pkgs: rec {
        grayboard = {
          type = "app";
          program = "${self.packages.${pkgs.system}.grayboard}/bin/grayboard";
        };
        grayboard-server = {
          type = "app";
          program = "${self.packages.${pkgs.system}.grayboard}/bin/grayboard-server";
        };
        default = grayboard;
      });

      checks = forAllSystems (pkgs: {
        version = pkgs.runCommand "grayboard-check-version"
          { }
          ''
            v="$(${self.packages.${pkgs.system}.grayboard}/bin/grayboard --version)"
            grep -q "${version}" <<< "$v" || { echo "expected ${version}, got $v" >&2; exit 1; }
            touch "$out"
          '';
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun ]; };
      });
    };
}
