FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS plugins
WORKDIR /build
COPY deploy/jenkins/plugins.lock.json /build/plugins.lock.json
COPY deploy/containers/plugins.mjs /build/plugins.mjs
RUN node /build/plugins.mjs /build/plugins.lock.json /build/plugins

FROM jenkins/jenkins:2.580.1-jdk21@sha256:a660310e39ade10631f774bacd5219de767dfd08947ea5c32a739b5e5bb382c1
USER jenkins
COPY --from=plugins --chown=jenkins:jenkins /build/plugins/ /usr/share/jenkins/ref/plugins/
COPY --chown=jenkins:jenkins deploy/jenkins/plugins.lock.json /opt/agent-platform/plugins.lock.json
COPY --chown=jenkins:jenkins deploy/containers/init.groovy.d/10-container-guard.groovy /usr/share/jenkins/ref/init.groovy.d/00-container-guard.groovy.override
COPY --chown=jenkins:jenkins --chmod=0555 deploy/containers/controller-entrypoint.sh /opt/agent-platform/controller-entrypoint.sh
ENV JAVA_OPTS="-Xms256m -Xmx1024m -Djenkins.install.runSetupWizard=false" \
    JENKINS_OPTS="--httpPort=8080" \
    AGENT_PLATFORM_CONTROLLER_MODE="lab"
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=4 CMD test -f /var/jenkins_home/container-state/ready.json && curl --fail --silent --output /dev/null http://127.0.0.1:8080/login || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/agent-platform/controller-entrypoint.sh"]
