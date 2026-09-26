# Paseo Docker Image

This directory contains the official Paseo daemon image.

The image runs the daemon headless and serves the bundled web UI from the same
HTTP origin. Start it, then open the daemon URL in a browser.

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:latest
```

Then open `http://localhost:6767`.

The base image intentionally does not bundle agent CLIs. Extend it with the
agents you use:

```Dockerfile
FROM ghcr.io/getpaseo/paseo:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code
```

See [docs/docker.md](../docs/docker.md) for Compose, reverse proxy, security,
agent auth, and troubleshooting notes.

## Agent Executor (AX)

`docker/ax/Dockerfile` builds `ghcr.io/fijimunkii/paseo-ax:<version>`, an AX-compatible
Paseo daemon image. It wraps the pinned upstream `ax-task-runner`, persists the runner's
state beneath `/workspace`, and starts the Paseo daemon as the unprivileged `paseo` user.

See [docs/ax-managed-hosts.md](../docs/ax-managed-hosts.md) for provisioning, lifecycle,
networking, persistence, and security behavior.
