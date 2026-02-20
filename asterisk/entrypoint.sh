#!/bin/sh
set -eu

CFG_DIR="/cfg"
AST_DIR="/etc/asterisk"

render() {
  src="$1"
  dst="$2"
  echo "[entrypoint] render ${src} -> ${dst}"
  envsubst < "${src}" > "${dst}"
}

copy_plain() {
  src="$1"
  dst="$2"
  echo "[entrypoint] copy ${src} -> ${dst}"
  cp "${src}" "${dst}"
}

# Render templates (uses env vars from docker-compose)
if [ -n "${FONIAL_USER:-}" ] && [ -n "${FONIAL_PASS:-}" ] && [ -n "${FONIAL_REGISTRAR:-}" ] && [ -n "${FONIAL_DOMAIN:-}" ]; then
  render "${CFG_DIR}/pjsip.conf.template" "${AST_DIR}/pjsip.conf"
  echo "[entrypoint] using fonial trunk config"

  if [ -n "${FONIAL_MATCH:-}" ]; then
    echo "[entrypoint] adding identify matches for trunk: ${FONIAL_MATCH}"
    {
      echo ""
      echo "; Auto-generated identify section"
      echo "[fonial-identify]"
      echo "type=identify"
      echo "endpoint=fonial-endpoint"
      OLDIFS="$IFS"
      IFS=','
      for ip in ${FONIAL_MATCH}; do
        ip_trim=$(echo "$ip" | tr -d ' ')
        [ -n "$ip_trim" ] && echo "match=${ip_trim}"
      done
      IFS="$OLDIFS"
    } >> "${AST_DIR}/pjsip.conf"
  fi
else
  copy_plain "${CFG_DIR}/pjsip.local.conf" "${AST_DIR}/pjsip.conf"
  echo "[entrypoint] using local PJSIP test config (set FONIAL_* in .env for trunk)"
fi

if [ -n "${EXTERNAL_ADDRESS:-}" ]; then
  echo "[entrypoint] applying NAT hints EXTERNAL_ADDRESS=${EXTERNAL_ADDRESS} LOCAL_NET=${LOCAL_NET:-}"
  # Insert after bind=... line inside transport-udp section.
  # This is intentionally simple and works for the configs in this repo.
  sed -i "/^bind=.*:5060$/a\\
external_signaling_address=${EXTERNAL_ADDRESS}\\
external_media_address=${EXTERNAL_ADDRESS}\\
local_net=${LOCAL_NET:-172.16.0.0/12}\\
" "${AST_DIR}/pjsip.conf"
fi
render "${CFG_DIR}/ari.conf.template" "${AST_DIR}/ari.conf"

# Plain configs
copy_plain "${CFG_DIR}/extensions.conf" "${AST_DIR}/extensions.conf"
copy_plain "${CFG_DIR}/http.conf" "${AST_DIR}/http.conf"
copy_plain "${CFG_DIR}/rtp.conf" "${AST_DIR}/rtp.conf"
copy_plain "${CFG_DIR}/modules.conf" "${AST_DIR}/modules.conf"

# Helpful: ensure log directories exist
mkdir -p /var/log/asterisk
mkdir -p /var/log/asterisk/cdr-csv

echo "[entrypoint] starting asterisk..."
exec asterisk -f -vvv
