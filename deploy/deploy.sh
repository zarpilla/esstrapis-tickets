#!/bin/sh
# Run by the GitHub Actions deploy key (forced command in ~/.ssh/authorized_keys):
# pulls the latest image, restarts the container and waits until it's healthy.
set -eu
cd "${TICKETS_DIR:-/var/www/tiquets}"
docker compose pull -q tickets
docker compose up -d tickets
container=$(docker compose ps -q tickets)
status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$container")
  [ "$status" = healthy ] && break
  sleep 2
done
if [ "$status" != healthy ]; then
  echo "Container is $status after 60 s" >&2
  docker compose logs --tail 50 tickets >&2
  exit 1
fi
docker image prune -f >/dev/null
echo "Deployed $(docker inspect -f '{{.Config.Image}} {{.Image}}' "$container")"
