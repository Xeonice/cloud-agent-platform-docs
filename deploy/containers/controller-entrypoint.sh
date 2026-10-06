#!/bin/bash
set -euo pipefail
umask 077
case "${AGENT_PLATFORM_CONTROLLER_MODE:-}" in
  lab|migration|active) ;;
  *) echo 'A reviewed controller mode is required' >&2; exit 1 ;;
esac
if [[ -L "${JENKINS_HOME}/container-state" ]]; then
  echo 'Controller readiness directory must not be a symlink' >&2
  exit 1
fi
mkdir -p "${JENKINS_HOME}/container-state"
chmod 700 "${JENKINS_HOME}/container-state"
rm -f "${JENKINS_HOME}/container-state/ready.json"
exec /usr/local/bin/jenkins.sh "$@"
