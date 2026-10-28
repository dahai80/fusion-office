#!/usr/bin/env bash
# Lifecycle for the fusion-office document-capability service.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../.."
venv="$root/.venv/bin/activate"
# Registered in architecture/port-registry.yaml as fusion-office-api (issue #3).
# Python resolves the same env var via fusion_core.config.service_port.
PORT="${FUSION_OFFICE_API_PORT:-11492}"
run_dir="$here/.run"
log_dir="$here/dev"
pid_file="$run_dir/office-api.pid"
log_file="$log_dir/office-api.log"

mkdir -p "$run_dir" "$log_dir"

running() {
    [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

start() {
    if running; then
        echo "office-api already running (pid $(cat "$pid_file"))"
        return 0
    fi
    # shellcheck disable=SC1090
    source "$venv"
    cd "$here"
    # office_api.main.run resolves the port via fusion_core.config and sets
    # the process title to fusion-office-api (issue #3); uvicorn CLI would skip both.
    export FUSION_OFFICE_API_PORT="$PORT"
    PYTHONPATH=src nohup python -m office_api.main >>"$log_file" 2>&1 &
    echo $! >"$pid_file"
    for _ in $(seq 1 50); do
        if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
            echo "office-api listening on 127.0.0.1:$PORT (pid $(cat "$pid_file"))"
            return 0
        fi
        sleep 0.2
    done
    echo "office-api did not become healthy; see $log_file" >&2
    return 1
}

stop() {
    if ! running; then
        rm -f "$pid_file"
        echo "office-api not running"
        return 0
    fi
    kill "$(cat "$pid_file")"
    rm -f "$pid_file"
    echo "office-api stopped"
}

status() {
    if running; then
        echo "office-api running (pid $(cat "$pid_file")) on port $PORT"
    else
        echo "office-api stopped"
        return 1
    fi
}

case "${1:-start}" in
    start) start ;;
    stop) stop ;;
    restart) stop; start ;;
    status) status ;;
    log) tail -n "${2:-50}" "$log_file" ;;
    *)
        echo "usage: $0 {start|stop|restart|status|log [lines]}" >&2
        exit 2
        ;;
esac
