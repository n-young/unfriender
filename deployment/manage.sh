#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

case "${1:-}" in
  up)
    mkdir -p .data
    chmod 700 .data
    docker compose up -d --build
    docker compose ps
    ;;
  down)
    docker compose down
    ;;
  restart)
    docker compose restart app
    ;;
  status)
    docker compose ps
    ;;
  logs)
    docker compose logs --tail=200 -f app
    ;;
  *)
    echo "usage: $0 {up|down|restart|status|logs}" >&2
    exit 2
    ;;
esac
