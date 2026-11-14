# The package worker builds the Linux native closure on the deployment libc.
# Build only from prepare-deploy-context.mjs, without instance/admin secrets.
FROM jenkins/inbound-agent:3391.va_37fa_a_305d6d-4-jdk21@sha256:c5d50ca09a7de45999983c69e0527499ca667efe00a85cf1ce5ed968b5b21719 AS remoting
FROM rockylinux:8@sha256:9794037624aaa6212aeada1d28861ef5e0a935adaf93e4ef79837119f2a2d04c

ARG TARGETARCH
ENV NODE_VERSION=22.23.3 \
    PNPM_VERSION=9.15.0 \
    COREPACK_HOME=/opt/agent-platform/corepack \
    COREPACK_DEFAULT_TO_LATEST=0 \
    PATH=/opt/rh/gcc-toolset-12/root/usr/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHON=/usr/bin/python3.11 \
    npm_config_build_from_source=true \
    HOME=/home/jenkins \
    JAVA_HOME=/opt/java/openjdk \
    JENKINS_AGENT_NAME=linux-arm64-package \
    JENKINS_AGENT_SECRET_FILE=/run/secrets/jenkins_agent_secret \
    NEXT_TELEMETRY_DISABLED=1

RUN test "$TARGETARCH" = arm64 \
    && dnf install -y ca-certificates curl xz tar gzip git python3.11 make gcc-toolset-12-gcc-c++ java-21-openjdk-headless shadow-utils \
    && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" \
    && printf '%s  /tmp/node.tar.xz\n' a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && mkdir -p /opt/java \
    && ln -s "$(dirname "$(dirname "$(readlink -f /usr/bin/java)")")" /opt/java/openjdk \
    && corepack enable \
    && corepack prepare pnpm@9.12.0 \
    && corepack prepare "pnpm@$PNPM_VERSION" --activate \
    && dnf clean all \
    && rm -rf /var/cache/dnf /root/.npm

COPY --from=remoting /usr/share/jenkins/agent.jar /usr/share/jenkins/agent.jar
COPY tools/ /opt/agent-platform/tools/
COPY upgrade/ /opt/agent-platform/upgrade/
COPY container-tools/ /opt/agent-platform/container-tools/
RUN /usr/sbin/groupadd --gid 1000 jenkins \
    && /usr/sbin/useradd --uid 1000 --gid 1000 --home-dir /home/jenkins --create-home jenkins \
    && mkdir -p /srv/agent-platform/deploy /home/jenkins/agent \
    && chown -R 1000:1000 /srv/agent-platform /home/jenkins \
    && chmod 700 /srv/agent-platform/deploy \
    && chmod -R a+rX /opt/agent-platform/corepack \
    && chmod -R go-w /opt/agent-platform /usr/local/lib/node_modules \
    && node --input-type=module -e "const { nativeBuildEnvironment } = await import('/opt/agent-platform/tools/deploy/upgrade/native-build-environment.mjs'); const actual = nativeBuildEnvironment(); if (actual.platform !== 'linux' || actual.arch !== 'arm64' || actual.nodeABI !== '127') throw Error('Package worker native identity rejected'); console.log(JSON.stringify(actual));" \
    && /opt/java/openjdk/bin/java -version \
    && gcc --version \
    && "$PYTHON" --version \
    && node --check /opt/agent-platform/tools/deploy/containers/publication-entrypoint.mjs

USER 1000:1000
WORKDIR /home/jenkins/agent
ENTRYPOINT ["/usr/local/bin/node", "/opt/agent-platform/tools/deploy/containers/publication-entrypoint.mjs"]
