#!/usr/bin/env bash
set -euo pipefail

AX_IMAGE="${AX_IMAGE:-${1:-}}"
if [[ -z "${AX_IMAGE}" ]]; then
  echo "AX_IMAGE or an image argument is required" >&2
  exit 2
fi

task_yaml="$(cat <<'EOF'
apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: smoke
  atespace: default
spec:
  command:
    - paseo-ax-daemon
  debug: false
EOF
)"

cid="$(docker run -d -p 127.0.0.1::80 -e AX_TASK_YAML="${task_yaml}" -e PASEO_AX_BOOTSTRAP_TOKEN=smoke-token "${AX_IMAGE}")"
tmpdir="$(mktemp -d)"
cleanup() {
  docker rm -f "${cid}" >/dev/null 2>&1 || true
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

port="$(docker port "${cid}" 80/tcp | sed -E 's/.*:([0-9]+)$/\1/' | head -n1)"
test -n "${port}"

for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${port}/readyz" >/dev/null; then
    break
  fi
  sleep 0.5
done

curl --fail --silent "http://127.0.0.1:${port}/healthz" >/dev/null
curl --fail --silent "http://127.0.0.1:${port}/readyz" >/dev/null
curl --fail --silent "http://127.0.0.1:${port}/metadata/v1alpha1/ax/task" | grep -q "name: smoke"

code="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/paseo/bootstrap/pairing")"
test "${code}" = "401"

for _ in $(seq 1 60); do
  if docker exec "${cid}" test -f /workspace/.paseo-host/pairing.json; then
    break
  fi
  sleep 0.5
done
docker exec "${cid}" test -f /workspace/.paseo-host/pairing.json

curl --silent --output "${tmpdir}/pairing-a.json" --write-out '%{http_code}' \
  -H "x-paseo-bootstrap-token: smoke-token" \
  "http://127.0.0.1:${port}/paseo/bootstrap/pairing" >"${tmpdir}/code-a" &
pid_a=$!
curl --silent --output "${tmpdir}/pairing-b.json" --write-out '%{http_code}' \
  -H "x-paseo-bootstrap-token: smoke-token" \
  "http://127.0.0.1:${port}/paseo/bootstrap/pairing" >"${tmpdir}/code-b" &
pid_b=$!
wait "${pid_a}"
wait "${pid_b}"

code_a="$(cat "${tmpdir}/code-a")"
code_b="$(cat "${tmpdir}/code-b")"
if [[ "${code_a}" == "200" ]]; then
  test "${code_b}" != "200"
  grep -q "#offer=" "${tmpdir}/pairing-a.json"
else
  test "${code_b}" = "200"
  grep -q "#offer=" "${tmpdir}/pairing-b.json"
fi

code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H "x-paseo-bootstrap-token: smoke-token" \
  "http://127.0.0.1:${port}/paseo/bootstrap/pairing")"
test "${code}" = "410"
