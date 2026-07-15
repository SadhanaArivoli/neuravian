#!/usr/bin/env bash

set -euo pipefail

readonly CADDY_TAG="caddy:2.10.2-alpine"
readonly GATEWAY_DIR="/srv/neuroforge/public-gateway"
readonly CADDYFILE="${GATEWAY_DIR}/Caddyfile"

fail() {
  printf '[REMOTE VM] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "Run this script as root"
[[ $# -eq 3 ]] || fail "Usage: configure-public-gateway.sh HOSTNAME USERNAME BCRYPT_HASH_FILE"

readonly PUBLIC_HOSTNAME="$1"
readonly AUTH_USERNAME="$2"
readonly AUTH_HASH_FILE="$3"

[[ -s "${AUTH_HASH_FILE}" ]] || fail "Bcrypt hash file is missing"
AUTH_HASH="$(tr -d '\r\n' <"${AUTH_HASH_FILE}")"
readonly AUTH_HASH

[[ "${PUBLIC_HOSTNAME}" =~ ^[a-z0-9.-]+$ ]] || fail "Hostname contains unsupported characters"
[[ "${AUTH_USERNAME}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail "Username contains unsupported characters"
[[ "${AUTH_HASH}" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || fail "Expected one bcrypt password hash"

docker pull "${CADDY_TAG}"
readonly CADDY_IMAGE="$(docker image inspect --format '{{index .RepoDigests 0}}' "${CADDY_TAG}")"
[[ "${CADDY_IMAGE}" == caddy@sha256:* ]] || fail "Could not resolve the Caddy image digest"

install -d -m 0750 "${GATEWAY_DIR}"
install -d -m 0750 "${GATEWAY_DIR}/data" "${GATEWAY_DIR}/config"

cat >"${CADDYFILE}" <<EOF
${PUBLIC_HOSTNAME} {
  encode zstd gzip

  basic_auth {
    ${AUTH_USERNAME} ${AUTH_HASH}
  }

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    -Server
  }

  reverse_proxy 127.0.0.1:3000
}
EOF
chmod 0640 "${CADDYFILE}"

docker run --rm \
  --volume "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
  "${CADDY_IMAGE}" caddy validate --config /etc/caddy/Caddyfile

cat >/etc/systemd/system/neuroforge-public-gateway.service <<EOF
[Unit]
Description=Authenticated HTTPS gateway for NeuroForge
Requires=docker.service neuroforge.service
After=docker.service neuroforge.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f neuroforge-public-gateway
ExecStart=/usr/bin/docker run --rm --name neuroforge-public-gateway --network host --volume ${CADDYFILE}:/etc/caddy/Caddyfile:ro --volume ${GATEWAY_DIR}/data:/data --volume ${GATEWAY_DIR}/config:/config ${CADDY_IMAGE}
ExecStop=/usr/bin/docker stop --time 30 neuroforge-public-gateway
Restart=on-failure
RestartSec=5
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now neuroforge-public-gateway.service

printf '[REMOTE VM] Public gateway enabled at https://%s using %s\n' "${PUBLIC_HOSTNAME}" "${CADDY_IMAGE}"
