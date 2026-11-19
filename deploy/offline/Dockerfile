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

ARG HOMELAB_DSH_PLUGINS_COMMIT=f88c13f5d1ab35e1b429c5d63233e052a427a3c7
RUN mkdir -p /opt/homelab-dsh-plugins \
    && git -C /opt/homelab-dsh-plugins init \
    && git -C /opt/homelab-dsh-plugins remote add origin https://github.com/recrack/homelab-dsh-plugins.git \
    && git -C /opt/homelab-dsh-plugins fetch --depth=1 origin "$HOMELAB_DSH_PLUGINS_COMMIT" \
    && git -C /opt/homelab-dsh-plugins checkout --detach FETCH_HEAD \
    && /opt/homelab-dsh-plugins/scripts/build.sh \
    && chmod -R a+rX /opt/homelab-dsh-plugins

WORKDIR /opt/dsh
COPY . .
ARG DSH_CLIENT_COMMIT_HASH
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm exec tsx native/system/scripts/build.ts \
    && pnpm rebuild esbuild node-pty koffi \
    && mkdir -p node_modules/@zseven-w \
    && ln -s /opt/homelab-dsh-plugins/packages/dsh-family-account node_modules/dsh-family-account \
    && ln -s /opt/homelab-dsh-plugins/packages/dsh-browser node_modules/@zseven-w/dsh-browser \
    && ln -s /opt/homelab-dsh-plugins/packages/dsh-super-kanban node_modules/dsh-super-kanban \
    && ln -s /opt/homelab-dsh-plugins/packages/dsh-context node_modules/dsh-context \
    && ln -s /opt/homelab-dsh-plugins/packages/open-artifacts/generated/dsh-claude-artifacts node_modules/dsh-claude-artifacts \
    && ln -s /opt/homelab-dsh-plugins/packages/open-artifacts/generated/dsh-claude-slides node_modules/dsh-claude-slides \
    && ln -s /opt/homelab-dsh-plugins/packages/open-artifacts/generated/dsh-claude-design node_modules/dsh-claude-design \
    && ln -s /opt/homelab-dsh-plugins/packages/open-artifacts/generated/dsh-claude-design-system node_modules/dsh-claude-design-system \
    && ln -s /opt/homelab-dsh-plugins/packages/open-artifacts/generated/dsh-claude-data node_modules/dsh-claude-data \
    && ln -s /opt/homelab-dsh-plugins/packages/open-artifacts/generated/dsh-claude-motion node_modules/dsh-claude-motion \
    && ln -s /opt/homelab-dsh-plugins/packages/open-artifacts/generated/dsh-claude-whiteboard node_modules/dsh-claude-whiteboard \
    && ln -s /opt/homelab-dsh-plugins/packages/dsh-crew node_modules/@zseven-w/dsh-crew \
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
