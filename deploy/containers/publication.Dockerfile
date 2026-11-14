ARG CI_BASE_IMAGE
ARG QUALIFICATION_DIND_IMAGE
FROM ${CI_BASE_IMAGE} AS publisher
USER root
COPY tools/ /opt/agent-platform/tools/
COPY upgrade/ /opt/agent-platform/upgrade/
COPY container-tools/ /opt/agent-platform/container-tools/
RUN mkdir -p /srv/agent-platform/deploy /home/jenkins/agent && chown -R 1000:1000 /srv/agent-platform /home/jenkins/agent && chmod 700 /srv/agent-platform/deploy && chmod -R go-w /opt/agent-platform
USER 1000:1000
WORKDIR /home/jenkins/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/opt/agent-platform/tools/deploy/containers/publication-entrypoint.mjs"]
FROM docker:29.5.2-cli@sha256:9ba8e32bfc35a2c7ae2feb1e3241b2778ae21dee80f4dcd31d04e1cfdea86ea2 AS docker
FROM publisher AS builder
USER root
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/lib/docker/cli-plugins/
USER 1000:1000

FROM ${QUALIFICATION_DIND_IMAGE} AS qualification-daemon
FROM builder AS qualification
USER root
COPY --from=qualification-daemon /usr/local/bin/dockerd /usr/local/bin/dockerd
COPY --from=qualification-daemon /usr/local/bin/containerd /usr/local/bin/containerd
COPY --from=qualification-daemon /usr/local/bin/containerd-shim-runc-v2 /usr/local/bin/containerd-shim-runc-v2
COPY --from=qualification-daemon /usr/local/bin/runc /usr/local/bin/runc
RUN if command -v apt-get >/dev/null; then apt-get update && apt-get install -y --no-install-recommends iptables iproute2 && rm -rf /var/lib/apt/lists/*; elif command -v dnf >/dev/null; then dnf install -y iptables iproute && dnf clean all; else exit 1; fi && mkdir -p /var/lib/qualification-docker
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/opt/agent-platform/tools/deploy/containers/qualification-entrypoint.mjs"]
