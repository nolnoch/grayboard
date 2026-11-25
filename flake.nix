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
          # adapters/<harness>/grayboard.ts, so adapters/ must be present. An
          # allow-list, not an exclusion list: a directory added to the root
          # (nix/, docs/) must not enter the source and rehash the package.
          src = lib.cleanSourceWith {
            src = self;
            filter =
              path: type:
              let
                rel = lib.removePrefix (self.outPath + "/") (toString path);
                inTree =
                  rel == "src"
                  || rel == "adapters"
                  || lib.hasPrefix "src/" rel
                  || lib.hasPrefix "adapters/" rel;
                noModules = !lib.hasInfix "/node_modules" rel;
              in
              if toString path == self.outPath then
                true
              else if type == "directory" then
                inTree && noModules && baseNameOf path != "node_modules"
              else
                builtins.elem rel [
                  "package.json"
                  "bun.lock"
                  "tsconfig.json"
                  "LICENSE"
                ]
                || inTree;
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
            outputHash = "sha256-zCqRIDbl2/DNLu6bEssSeCNG0OakbdaaAZWcwlVb3HA=";
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

      overlays.default = final: prev: {
        grayboard = self.packages.${final.stdenv.hostPlatform.system}.grayboard;
      };

      # The module's default package follows the evaluating system, so the
      # output stays one module for every system.
      nixosModules.default =
        { pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          _module.args.grayboard-package = self.packages.${pkgs.stdenv.hostPlatform.system}.grayboard;
        };

      # The version check runs everywhere; the NixOS VM test that starts the
      # server through the module needs Linux. `nix flake check` builds and
      # runs these, and that run is the gate for bunDeps' hash: a store that
      # already holds the old output can't tell a stale one (AGENTS.md).
      checks = forAllSystems (
        pkgs:
        {
          version = pkgs.runCommand "grayboard-check-version"
            { }
            ''
              v="$(${self.packages.${pkgs.system}.grayboard}/bin/grayboard --version)"
              grep -q "${version}" <<< "$v" || { echo "expected ${version}, got $v" >&2; exit 1; }
              touch "$out"
            '';
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          module = pkgs.testers.runNixOSTest {
            name = "grayboard-server-module";
            nodes.machine =
              { pkgs, ... }:
              {
                imports = [ self.nixosModules.default ];
                services.grayboard-server = {
                  enable = true;
                  # Dev auth: the server accepts it only from a loopback public
                  # URL, which is what a VM has. No secrets, so no env file
                  # (the default /etc/grayboard/env would have to exist).
                  environmentFile = null;
                  environment = {
                    GRAYBOARD_DEV_AUTH = "1";
                    GRAYBOARD_DB_PATH = "/var/lib/grayboard/bus.db";
                    GRAYBOARD_PUBLIC_URL = "http://localhost:8080";
                  };
                };
                environment.systemPackages = [ pkgs.curl ];
              };
            testScript = ''
              import json

              machine.wait_for_unit("grayboard")
              machine.wait_for_open_port(8080)
              health = json.loads(machine.succeed("curl -s http://localhost:8080/healthz"))
              assert health["ok"] is True, health
              assert health["version"] == "${version}", health
              # Under ProtectSystem=strict the state directory is the one
              # writable place, and the service user owns it.
              machine.succeed("test -f /var/lib/grayboard/bus.db")
              machine.succeed("stat -c %U /var/lib/grayboard/bus.db | grep -q '^grayboard$'")
            '';
          };
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun ]; };
      });
    };
}
