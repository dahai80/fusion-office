#!/bin/bash
# Fusion Office — lifecycle for the union-shell host.
# Serves the five built apps on fixed ports and registers their manifests
# with fusion-gateway. Follows the fusion-supervisor contract:
#   ./start.sh start|stop|restart|status|log
#
# The admin key comes from (first match wins):
#   1. FUSION_GATEWAY_ADMIN_KEY in the environment
#   2. .env.local next to this script
#   3. web_shell.admin_key in fusion-gateway/config.yaml

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/dev/shell-serve.pid"
LOG_FILE="$SCRIPT_DIR/dev/shell-serve.log"
BASE_PORT="${FUSION_OFFICE_SHELL_PORT:-11485}"
GATEWAY_CONFIG="${FUSION_GATEWAY_CONFIG:-$SCRIPT_DIR/../fusion-gateway/config.yaml}"

log() { echo "[office-shell] $*"; }
fail() { echo "[office-shell] ERROR: $*" >&2; exit 1; }

resolve_admin_key() {
    if [ -n "${FUSION_GATEWAY_ADMIN_KEY:-}" ]; then
        echo "$FUSION_GATEWAY_ADMIN_KEY"
        return
    fi
    if [ -f "$SCRIPT_DIR/.env.local" ]; then
        local key
        key="$(grep -E '^FUSION_GATEWAY_ADMIN_KEY=' "$SCRIPT_DIR/.env.local" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
        if [ -n "$key" ]; then
            echo "$key"
            return
        fi
    fi
    if [ -f "$GATEWAY_CONFIG" ]; then
        awk '/^web_shell:/{in_shell=1; next} in_shell && /^  admin_key:/{print $2; exit}' "$GATEWAY_CONFIG"
        return
    fi
    echo ""
}

pid_alive() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

cmd_start() {
    if pid_alive; then
        log "already running (pid $(cat "$PID_FILE"))"
        return 0
    fi
    local missing=0
    for app in documents spreadsheet presentation pdf pm; do
        [ -f "apps/$app/dist/index.html" ] || { log "missing apps/$app/dist (run npm run build)"; missing=1; }
    done
    [ "$missing" -eq 0 ] || fail "not all five apps are built"
    local key
    key="$(resolve_admin_key)"
    [ -n "$key" ] || fail "no FUSION_GATEWAY_ADMIN_KEY (env, .env.local, or $GATEWAY_CONFIG)"
    mkdir -p "$SCRIPT_DIR/dev"
    : > "$LOG_FILE"
    FUSION_GATEWAY_ADMIN_KEY="$key" FUSION_OFFICE_SHELL_PORT="$BASE_PORT" \
        nohup node scripts/shell-serve.mjs >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    log "started pid $(cat "$PID_FILE") on ports $BASE_PORT-$((BASE_PORT + 4)); log: $LOG_FILE"
    # Wait for the documents server so callers (and the supervisor probe) see
    # a listening port, not a race; the process exits by itself on failure.
    local waited=0
    while [ "$waited" -lt 50 ]; do
        if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            tail -5 "$LOG_FILE" >&2 || true
            rm -f "$PID_FILE"
            fail "shell-serve exited during startup"
        fi
        if nc -z 127.0.0.1 "$BASE_PORT" 2>/dev/null; then
            log "documents server listening on $BASE_PORT"
            return 0
        fi
        sleep 0.2
        waited=$((waited + 1))
    done
    tail -5 "$LOG_FILE" >&2 || true
    fail "documents server did not listen on $BASE_PORT within 10s"
}

cmd_stop() {
    if ! pid_alive; then
        log "not running"
        rm -f "$PID_FILE"
        return 0
    fi
    local pid
    pid="$(cat "$PID_FILE")"
    log "stopping pid $pid (unregisters manifests on SIGTERM)"
    kill -TERM "$pid" 2>/dev/null || true
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 50 ]; do
        sleep 0.2
        waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        log "graceful stop timed out, sending SIGKILL"
        kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    log "stopped"
}

case "${1:-start}" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_stop; cmd_start ;;
    status)
        if pid_alive; then
            log "running (pid $(cat "$PID_FILE")), ports $BASE_PORT-$((BASE_PORT + 4))"
            exit 0
        else
            log "stopped"
            exit 1
        fi
        ;;
    log) tail -n "${2:-50}" "$LOG_FILE" 2>/dev/null || log "no log yet" ;;
    *) echo "usage: $0 start|stop|restart|status|log [lines]" >&2; exit 2 ;;
esac
