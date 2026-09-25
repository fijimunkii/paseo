# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
ARG GO_IMAGE=golang:1.27.1-bookworm
ARG PYTHON_IMAGE=python:3.12-slim
ARG AX_COMMIT=c5c1ac5b3d66f4b4747825fa4ddb5880b5e1177b

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG PASEO_VERSION
ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/paseo-src
COPY . .

RUN set -eux; \
    if [ -n "${PASEO_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${PASEO_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/highlight --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/relay --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/protocol --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/client --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/plugin --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/server --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/cli --pack-destination /tmp/paseo-packs

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS ax-runner-build

ARG AX_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/ax
RUN git clone --filter=blob:none https://github.com/google/ax.git . \
    && git checkout --detach "${AX_COMMIT}"

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/ax-task-runner ./cmd/ax-task-runner

FROM ${NODE_IMAGE} AS node-runtime

FROM ${PYTHON_IMAGE}

ENV HOME=/workspace/.paseo-host/home \
    PASEO_HOME=/workspace/.paseo-host/home/.paseo \
    PASEO_LISTEN=127.0.0.1:6767 \
    PASEO_WEB_UI_ENABLED=false \
    PASEO_LOG_FORMAT=json \
    PASEO_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/workspace/.paseo-host/home/.claude \
    CODEX_HOME=/workspace/.paseo-host/home/.codex \
    XDG_CONFIG_HOME=/workspace/.paseo-host/home/.config \
    XDG_DATA_HOME=/workspace/.paseo-host/home/.local/share \
    XDG_STATE_HOME=/workspace/.paseo-host/home/.local/state \
    XDG_CACHE_HOME=/workspace/.paseo-host/home/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      libstdc++6 \
      openssh-client \
      procps; \
    rm -rf /var/lib/apt/lists/*; \
    pip install --no-cache-dir google-antigravity

COPY --from=ax-runner-build /out/ax-task-runner /usr/local/bin/ax-task-runner-upstream
COPY --from=ax-runner-build /src/ax/cmd/ax-task-runner/antigravity_bootstrap.py /usr/local/bin/antigravity_bootstrap.py

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY --from=source-pack /tmp/paseo-packs /tmp/paseo-packs
RUN set -eux; \
    npm install -g /tmp/paseo-packs/*.tgz; \
    rm -rf /tmp/paseo-packs; \
    npm cache clean --force; \
    paseo --version

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "paseo" ]; then \
      groupmod --new-name paseo "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 paseo; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "paseo" ]; then \
      usermod --login paseo --gid paseo --home "$HOME" --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid paseo --home-dir "$HOME" --shell /bin/bash paseo; \
    fi

COPY docker/ax/rootfs/ /
RUN chmod +x /usr/local/bin/ax-task-runner /usr/local/bin/paseo-ax-daemon

WORKDIR /workspace

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/ax-task-runner"]
