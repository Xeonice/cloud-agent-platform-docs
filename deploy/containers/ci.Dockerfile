# Build with the assembled public-only context, never the project checkout.
# One image supports linux/arm64 generic CI and linux/amd64 production web builds.
FROM jenkins/inbound-agent:3391.va_37fa_a_305d6d-4-jdk21@sha256:c5d50ca09a7de45999983c69e0527499ca667efe00a85cf1ce5ed968b5b21719

USER root
ARG TARGETARCH
ENV NODE_VERSION=22.23.3 \
    PNPM_VERSION=9.15.0 \
    COREPACK_HOME=/opt/agent-platform/corepack \
    COREPACK_DEFAULT_TO_LATEST=0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/agent-platform/playwright \
    VERCEL_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git tar tini python3 make g++ \
    && case "$TARGETARCH" in \
       arm64) node_arch=arm64; node_sha=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f ;; \
       amd64) node_arch=x64; node_sha=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de ;; \
       *) exit 1 ;; \
       esac \
    && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$node_arch.tar.xz" \
    && printf '%s  /tmp/node.tar.xz\n' "$node_sha" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && corepack enable \
    && corepack prepare "pnpm@$PNPM_VERSION" --activate \
    && rm -rf /var/lib/apt/lists/*

COPY ci-tools/package.json ci-tools/package-lock.json /opt/agent-platform/vercel/
RUN npm ci --prefix /opt/agent-platform/vercel --ignore-scripts --no-audit --no-fund \
    && node /opt/agent-platform/vercel/node_modules/playwright/cli.js install --with-deps chromium \
    && node /opt/agent-platform/vercel/node_modules/vercel/dist/index.js --version \
    && chmod -R a+rX /opt/agent-platform \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY tools/jenkins-ci.mjs tools/project-ci.mjs tools/jenkins-web.mjs tools/mutation.mjs \
     tools/ci-platform.mjs tools/deployment-platform.mjs tools/ci-agent-entrypoint.mjs /opt/agent-platform/tools/
RUN corepack prepare pnpm@9.12.0 \
    && corepack prepare "pnpm@$PNPM_VERSION" --activate \
    && chmod -R a+rX /opt/agent-platform/corepack
RUN chmod -R go-w /opt/agent-platform /usr/local/lib/node_modules \
    && mkdir -p /home/jenkins/tmp /home/jenkins/agent /home/jenkins/pnpm-store \
    && chown -R 1000:1000 /home/jenkins \
    && node --check /opt/agent-platform/tools/ci-agent-entrypoint.mjs \
    && node --input-type=module -e "await import('/opt/agent-platform/tools/jenkins-web.mjs'); await import('/opt/agent-platform/tools/project-ci.mjs')"

ENV HOME=/home/jenkins \
    JENKINS_AGENT_NAME=linux-ci \
    JENKINS_AGENT_SECRET_FILE=/run/secrets/jenkins_agent_secret
USER 1000:1000
WORKDIR /home/jenkins/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/opt/agent-platform/tools/ci-agent-entrypoint.mjs"]
