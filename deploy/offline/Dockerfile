FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    npm_config_update_notifier=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        iptables util-linux python3 git build-essential musl-tools ca-certificates tcpdump chromium \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.28.5

ARG DSH_BROWSER_COMMIT=69fa75ac53c36c7f297fcce5ed2595fee62e068c
RUN mkdir -p /opt/dsh-deps/dsh-browser \
    && git -C /opt/dsh-deps/dsh-browser init \
    && git -C /opt/dsh-deps/dsh-browser remote add origin https://github.com/ZSeven-W/dsh-browser.git \
    && git -C /opt/dsh-deps/dsh-browser fetch --depth=1 origin "$DSH_BROWSER_COMMIT" \
    && git -C /opt/dsh-deps/dsh-browser checkout --detach FETCH_HEAD \
    && cd /opt/dsh-deps/dsh-browser \
    && pnpm install --frozen-lockfile \
    && pnpm run build

ARG DSH_CREW_COMMIT=b00cc6d039cdecf8563b8863aa4b5404285f6e83
RUN mkdir -p /opt/dsh-deps/dsh-crew \
    && git -C /opt/dsh-deps/dsh-crew init \
    && git -C /opt/dsh-deps/dsh-crew remote add origin https://github.com/ZSeven-W/dsh-crew.git \
    && git -C /opt/dsh-deps/dsh-crew fetch --depth=1 origin "$DSH_CREW_COMMIT" \
    && git -C /opt/dsh-deps/dsh-crew checkout --detach FETCH_HEAD \
    && pnpm --dir /opt/dsh-deps/dsh-crew install --prod --frozen-lockfile

WORKDIR /opt/dsh
COPY . .
ARG DSH_CLIENT_COMMIT_HASH
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm exec tsx native/system/scripts/build.ts \
    && pnpm rebuild esbuild node-pty koffi \
    && npm install --prefix deploy/offline/plugins/dsh-context --omit=dev --ignore-scripts --legacy-peer-deps --no-package-lock \
    && mkdir -p node_modules/@zseven-w \
    && ln -s ../deploy/offline/plugins/dsh-context node_modules/dsh-context \
    && ln -s ../deploy/offline/plugins/dsh-claude-artifacts node_modules/dsh-claude-artifacts \
    && ln -s ../deploy/offline/plugins/dsh-claude-design node_modules/dsh-claude-design \
    && ln -s /opt/dsh-deps/dsh-crew node_modules/@zseven-w/dsh-crew \
    && DSH_GATE_CONCURRENCY=2 pnpm run build:artifacts \
    && DSH_GATE_CONCURRENCY=2 pnpm run build:check \
    && chmod -R a+rX deploy/offline \
    && chmod 0555 deploy/offline/entrypoint.sh \
    && chown -R 65534:65534 deploy/offline/collector-home

WORKDIR /workspace
ENV DSH_WEB_PORT=3080
EXPOSE 3080
ENTRYPOINT ["/opt/dsh/deploy/offline/entrypoint.sh"]
CMD ["web", "--no-open"]
