# CI base is built locally from ci.Dockerfile; bootstrap pins its verified image ID.
ARG CI_BASE_IMAGE=agent-platform-ci:node22-arm64
FROM docker:29.5.2-cli@sha256:9ba8e32bfc35a2c7ae2feb1e3241b2778ae21dee80f4dcd31d04e1cfdea86ea2 AS docker
FROM ${CI_BASE_IMAGE}
USER root
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/lib/docker/cli-plugins/
COPY tools/ /opt/agent-platform/tools/
COPY macmini/ /opt/agent-platform/macmini/
COPY container-tools/ /opt/agent-platform/container-tools/
RUN chmod -R go-w /opt/agent-platform /usr/local/lib/docker/cli-plugins \
    && node --check /opt/agent-platform/tools/api-container.mjs \
    && node --check /opt/agent-platform/tools/deploy-agent-entrypoint.mjs \
    && docker --version && docker buildx version && docker compose version
ENV JENKINS_AGENT_NAME=linux-deploy
USER 1000:1000
WORKDIR /home/jenkins/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/opt/agent-platform/tools/deploy-agent-entrypoint.mjs"]
