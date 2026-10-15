#!/bin/sh
# Entry point for the portal / ops / worker containers.
set -eu

cmd="${1:-web}"
shift || true

case "$cmd" in
  web)
    socket="${LUMEN_SOCKET_PATH:-}"
    binds="--bind 0.0.0.0:8000"
    if [ -n "$socket" ]; then
      rm -f "$socket"
      binds="$binds --bind unix:$socket"
    fi
    workers="${GUNICORN_WORKERS:-3}"
    # shellcheck disable=SC2086
    exec gunicorn lumen.wsgi:application $binds \
      --umask 0o007 \
      --workers "$workers" --worker-class gthread --threads "${GUNICORN_THREADS:-4}" \
      --timeout 60 --graceful-timeout 25 --keep-alive 5 \
      --max-requests 2000 --max-requests-jitter 200 \
      --limit-request-line 8190 --limit-request-fields 100 \
      --worker-tmp-dir /tmp --no-control-socket \
      --error-logfile - --log-level "$(echo "${LOG_LEVEL:-INFO}" | tr 'A-Z' 'a-z')"
    ;;
  worker)
    exec python manage.py lumen_worker "$@"
    ;;
  migrate)
    python manage.py migrate --noinput
    exec python manage.py lumen_bootstrap
    ;;
  manage)
    exec python manage.py "$@"
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac
