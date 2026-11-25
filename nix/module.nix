# NixOS module: services.grayboard-server, the unit deploy/grayboard.service
# describes, with its environment as options. Secrets stay in environmentFile:
# systemd reads it as root before the service's own user and namespace apply,
# so it never has to be readable by the service user.
{
  lib,
  config,
  grayboard-package,
  ...
}:

let
  cfg = config.services.grayboard-server;
in
{
  options.services.grayboard-server = {
    enable = lib.mkEnableOption "the grayboard team server";

    package = lib.mkOption {
      type = lib.types.package;
      default = grayboard-package;
      description = "Package providing bin/grayboard-server.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "grayboard";
      description = "User the server runs as; it owns /var/lib/grayboard.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "grayboard";
      description = "Group of the service user.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        GRAYBOARD_DB_PATH = "/var/lib/grayboard/bus.db";
        GRAYBOARD_HTTP_PORT = "8080";
        GRAYBOARD_PUBLIC_URL = "https://grayboard.example.com";
      };
      description = ''
        The server's environment (docs/guide/server.md, step 3) as systemd
        Environment= lines. Not for secrets: systemd shows these to any user
        who can read the unit; put them in environmentFile.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = "/etc/grayboard/env";
      description = ''
        Env file with the secrets (mode 0600), the deploy unit's
        EnvironmentFile. null runs without one.
      '';
    };

    readWritePaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/srv/grayboard-blobs" ];
      description = ''
        Extra writable paths under ProtectSystem=strict. /var/lib/grayboard
        already is one; a GRAYBOARD_BLOB_DIR or sslrootcert CA bundle elsewhere
        needs its directory listed here (reading needs nothing).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.${cfg.group} = { };

    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = "/var/lib/grayboard";
    };

    systemd.services.grayboard = {
      description = "grayboard server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      inherit (cfg) environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        StateDirectory = "grayboard";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        ExecStart = "${cfg.package}/bin/grayboard-server";
        Restart = "always";
        RestartSec = 3;

        # The server writes under its state directory and nowhere else; a
        # path outside it goes through readWritePaths.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ReadWritePaths = cfg.readWritePaths;
      };
    };
  };
}
