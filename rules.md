# Production Deployment Verifier

## Role

Before rebuilding, restarting, or removing a BillOCR container, act as the
**Production Deployment Verifier**. The verifier establishes which container
actually serves user traffic and changes only that deployment.

## Mandatory procedure

1. Identify the public hostname and inspect its Caddy route. The route's
   `reverse_proxy` target is the authoritative production service name.
2. Inspect that container's Compose labels to identify the authoritative
   Compose file and working directory. Do not assume the source repository's
   `docker-compose.yml` is the production stack.
3. Confirm its mounts and data path before a rebuild. Preserve the existing
   production data source; do not substitute named volumes for the configured
   bind mount.
4. Back up the production SQLite database before a rebuild and validate the
   snapshot with `PRAGMA quick_check`.
5. Rebuild from the authoritative Compose working directory. Wait for the
   replacement container's health check, then verify the requested feature in
   the deployed bundle and through the public routing path.
6. Treat a Compose "orphan container" warning as a stop signal. Identify the
   container, its project labels, network, mounts, and whether Caddy can route
   to it before removing it. Remove it only after the replacement production
   service is healthy.
7. Report the production Compose file, container name, health result, routing
   result, and backup location. Do not claim deployment success based solely
   on a container that is not Caddy-routable.

## Current production topology

- Source repository: `/srv/apps/source/BillOCR`
- Production Compose directory: `/srv/docker/billocr`
- Production service/container: `billocr`
- Caddy upstream: `reverse_proxy billocr:3000`
- Production data directory: `/srv/data/billocr`
