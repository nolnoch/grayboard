# The server image (#1418): the release's own compiled server binary on a distroless base, no build inside.
# release.yml builds it from a context holding <arch>/grayboard-server (amd64, arm64), the same signed files the
# release publishes, so the image and `install.sh` run identical bytes. Only COPY, so a foreign platform builds
# without emulation. COPY keeps the binary's mode (0755, root-owned: the server can't rewrite itself).
#
# The base carries glibc and libstdc++ (a compiled Bun binary links both) and CA certificates, and runs as uid 65532.
# Dependabot moves the digest (.github/dependabot.yml).
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

ARG TARGETARCH
COPY ${TARGETARCH}/grayboard-server /usr/local/bin/grayboard-server

# GRAYBOARD_HTTP_PORT's default. Configuration is env only (docs/guide/server.md §3); secrets can be files (`<NAME>_FILE`).
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/grayboard-server"]
