# syntax=docker/dockerfile:1.7
#
# Craft Office: WordCraft, GridCraft and DeckCraft compiled to WebAssembly (Trunk) and served,
# together with the file portal, by one small Node.js server.
#
#   docker build -t craft-office .
#
# The upstream commits are pinned below; bump them to update the apps.

ARG RUST_IMAGE=rust:1.99-trixie
ARG NODE_IMAGE=node:24-alpine

# ---------- toolchain ----------
FROM ${RUST_IMAGE} AS toolchain
ARG TRUNK_VERSION=0.22.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends brotli \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && curl -fsSL "https://github.com/trunk-rs/trunk/releases/download/v${TRUNK_VERSION}/trunk-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin trunk \
 && trunk --version
# Fetch one commit of a GitHub repository: fetch <repo> <ref> <dir>
RUN printf '#!/bin/sh\nset -e\ngit init -q "$3"\ngit -C "$3" fetch -q --depth 1 "https://github.com/$1.git" "$2"\ngit -C "$3" checkout -q FETCH_HEAD\n' > /usr/local/bin/fetch \
 && chmod +x /usr/local/bin/fetch
# Precompress the build output for the server: compress <dir>
RUN printf '#!/bin/sh\nset -e\nfind "$1" -type f \\( -name "*.wasm" -o -name "*.js" -o -name "*.html" -o -name "*.css" \\) | while read -r f; do brotli -kfq 11 "$f"; gzip -kf9 "$f"; done\n' > /usr/local/bin/compress \
 && chmod +x /usr/local/bin/compress
# The apps pin forks (egui, winit) at commits no branch points to; the git CLI fetches those by hash.
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
WORKDIR /src

# ---------- WordCraft ----------
FROM toolchain AS wordcraft
ARG WORDCRAFT_REF=aadb077e072b7de05f724e359d8db82e151f125c
RUN fetch storytold/wordcraft "${WORDCRAFT_REF}" wordcraft \
 && fetch storytold/craft-i18n "$(tr -d '[:space:]' < wordcraft/craft-i18n.rev)" craft-i18n
# craft-i18n carries the interface translations (German among them); without it WordCraft is English only.
ENV CRAFT_I18N_DIR=/src/craft-i18n
WORKDIR /src/wordcraft/apps/wordcraft-web
RUN --mount=type=cache,id=cargo-registry,sharing=locked,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-git,sharing=locked,target=/usr/local/cargo/git \
    --mount=type=cache,id=target-wordcraft,target=/src/wordcraft/target \
    trunk build --release --dist /out && compress /out

# ---------- GridCraft ----------
FROM toolchain AS gridcraft
ARG GRIDCRAFT_REF=146161b4b450a56e5e59a083ba0478582d1e602b
RUN fetch storytold/gridcraft "${GRIDCRAFT_REF}" gridcraft
WORKDIR /src/gridcraft/apps/gridcraft-web
RUN --mount=type=cache,id=cargo-registry,sharing=locked,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-git,sharing=locked,target=/usr/local/cargo/git \
    --mount=type=cache,id=target-gridcraft,target=/src/gridcraft/target \
    trunk build --release --dist /out && compress /out

# ---------- DeckCraft ----------
FROM toolchain AS deckcraft
ARG DECKCRAFT_REF=f893f6af7d36a5409fd804e81a34fd895cfefedf
RUN fetch storytold/deckcraft "${DECKCRAFT_REF}" deckcraft
# DeckCraft has no host bridge upstream yet; this adds one matching WordCraft's and GridCraft's.
COPY patches/deckcraft-host-bridge.patch /src/
RUN git -C deckcraft apply --whitespace=nowarn /src/deckcraft-host-bridge.patch
WORKDIR /src/deckcraft/apps/deckcraft-web
RUN --mount=type=cache,id=cargo-registry,sharing=locked,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-git,sharing=locked,target=/usr/local/cargo/git \
    --mount=type=cache,id=target-deckcraft,target=/src/deckcraft/target \
    trunk build --release --dist /out && compress /out

# ---------- portal ----------
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/gottschalkfelix4-source/craft-office" \
      org.opencontainers.image.title="Craft Office" \
      org.opencontainers.image.description="WordCraft, GridCraft and DeckCraft as browser-native web office (WebAssembly) with a file portal"
RUN apk add --no-cache su-exec
WORKDIR /opt/portal
COPY portal/server.js ./
COPY portal/public ./public
COPY --from=wordcraft /out ./apps/word
COPY --from=gridcraft /out ./apps/grid
COPY --from=deckcraft /out ./apps/deck
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/
# PUID / PGID: who owns /data and runs the server (default 99:100, Unraid's nobody:users).
ENV PORT=8080 DATA_DIR=/data APPS_DIR=/opt/portal/apps PUBLIC_DIR=/opt/portal/public NODE_ENV=production PUID=99 PGID=100
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
