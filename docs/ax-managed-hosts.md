# AX managed hosts

Paseo can provision a remote host on [Google AX / Agent Executor](https://github.com/google/ax).
AX is an execution substrate, so Paseo integrates it at the **host/daemon boundary** rather than as
an agent provider.

An AX Task runs a normal Paseo daemon. The daemon then runs the same provider implementations it
uses on any other host.

```text
Paseo desktop / mobile / CLI
           │
           │ existing Paseo host protocol
           │ E2EE relay in production
           ▼
       AX Task
         └── Paseo daemon
               ├── Codex
               ├── Claude
               ├── ACP agents
               ├── OpenCode
               └── Pi / OMP
```

## Requirements

Provisioning and AX lifecycle operations run locally, so they currently require either:

- Paseo Desktop, or
- the Paseo CLI.

The machine performing those operations must have:

- the `ax` CLI installed;
- `kubectl` installed;
- a Kubernetes context that can reach the AX control plane and the `atenet-router` Service;
- an AX cluster compatible with the `v1alpha1` CLI/API contract.

Mobile and browser clients do not need Kubernetes or AX credentials. After provisioning they connect
to the AX-backed daemon through the ordinary Paseo relay host connection.

## Provision from the CLI

```bash
paseo ax provision paseo-dev \
  --context my-cluster \
  --repo https://github.com/example/project.git \
  --branch main
```

Provisioning is create-only for the AX Task name. If that task already exists, Paseo refuses to
overwrite it; use the existing managed host or destroy the AX host first.

Paseo generates collision-resistant Workspace and Gateway names for each provision attempt and
returns them in the CLI output. Callers do not choose these owned resource names.

The command:

1. verifies the local AX CLI contract;
2. verifies that the requested Task name does not already exist;
3. generates owned Workspace/Gateway names and a one-time bootstrap token;
4. applies the Gateway, Workspace, and Task with AX `debug: false`;
5. waits for AX's `Ready=True` condition;
6. briefly port-forwards the AX `atenet-router` through `kubectl`;
7. retrieves the task's one-time Paseo pairing offer through a token-authenticated HTTP endpoint;
8. stores the resulting encrypted relay connection and AX resource identity.

Desktop exposes the same flow from **Settings → Add host → Agent Executor (AX)**.

If provisioning fails after resources were applied, Paseo attempts to delete the Task, Workspace, and
Gateway before returning the original error.

## Pairing bootstrap

Paseo does **not** enable AX guest debug services and does not use `ax ssh`.

The AX image fronts the upstream runner with a small HTTP proxy on port 80. Standard AX endpoints
such as `/healthz`, `/readyz`, and metadata continue through to the upstream runner. Paseo adds one
endpoint:

```text
GET /paseo/bootstrap/pairing
```

It requires the randomly generated `x-paseo-bootstrap-token` header. The request is sent through the
normal AX atenet router with:

```text
ate-target-actor: <atespace>/<task>
```

The task command creates the relay offer before starting the Paseo daemon. The proxy serves that
offer once, writes a durable `bootstrap-complete` marker, deletes the offer file, and never exposes
it again. AX resumes therefore do not reopen pairing even though the immutable Task launch spec still
contains the bootstrap token.

## Resource identity

A managed host stores the exact AX target needed for later lifecycle operations:

- Kubernetes context;
- AX namespace;
- atespace;
- Task name;
- Workspace name;
- Gateway name.

The Kubernetes context is intentionally persisted. Suspend, resume, and destroy must not silently
follow whichever context happens to be active later.

The Workspace and Gateway are treated as resources owned by this Paseo managed host. Paseo allocates
collision-resistant names for both resources during provisioning, stores those exact names in the
host lifecycle record, and deletes them when the managed host is destroyed.

## Networking

The Paseo daemon itself is never exposed through AX ingress.

The generated Task binds Paseo to `127.0.0.1:6767`, and Paseo connects outbound to the relay. The
only bootstrap traffic routed through atenet is the short-lived token-authenticated pairing request
to the runner proxy on port 80.

The generated Gateway contains an explicit HTTPS egress allowlist. Paseo always adds
`relay.paseo.sh:443` because the managed host depends on relay connectivity. The default workload
allowlist also includes common Git and model endpoints. Override it when the workload needs a
different set:

```bash
paseo ax provision paseo-dev \
  --context my-cluster \
  --egress-host api.openai.com github.com
```

No provider API keys are emitted into the generated Task manifest.

## Durable state

AX suspension preserves `/workspace`; it does **not** preserve the process tree.

The Paseo AX image therefore roots durable state under:

```text
/workspace/.paseo-host/
├── ax/                  # AX runner maiden-run markers/state
├── bootstrap-complete
├── ownership-v1
└── home/
    ├── .paseo/
    ├── .codex/
    ├── .claude/
    ├── .config/
    └── .local/
```

The image wraps the upstream `ax-task-runner` and relocates its normal `/ax` state into the durable
workspace. Without that relocation, a resumed container could lose the runner's maiden-run marker
and repeat workspace initialization.

The first command start performs one ownership handoff of the prepared workspace to the unprivileged
`paseo` user and records `ownership-v1`. Resumes reuse that durable ownership instead of recursively
chowning the workspace again.

## Suspend and resume

Desktop host settings and the CLI expose AX lifecycle operations:

```bash
paseo ax inspect paseo-dev --context my-cluster
paseo ax suspend paseo-dev --context my-cluster
paseo ax resume paseo-dev --context my-cluster
```

Desktop refuses Suspend while an agent is initializing or running. Suspending an AX Task terminates
its live process tree. Resuming starts a fresh container against the restored workspace; the Paseo
daemon then loads its persisted identity and agent/session metadata normally.

Background shells and provider processes are not checkpointed and are not claimed to survive a
suspend/resume.

## Remove versus destroy

**Remove host** only forgets the Paseo host profile. It leaves the AX Task, Workspace, and Gateway
alone.

**Destroy AX host** deletes, in order:

1. Task;
2. Workspace;
3. Gateway;

and then removes the Paseo host profile. Desktop requires explicit destructive confirmation.

From the CLI:

```bash
paseo ax destroy paseo-dev \
  --context my-cluster \
  --workspace paseo-dev-ws-<suffix> \
  --gateway paseo-dev-gw-<suffix>
```

The CLI requires the **exact** Workspace and Gateway names returned by `paseo ax provision`; it
does not derive or guess them. Desktop does not need the flags because it persists those names in
the host lifecycle record.

## Image

The official AX image is:

```text
ghcr.io/fijimunkii/paseo-ax:<version>
```

Release builds also publish `:latest` for non-prerelease releases.

The image builds the pinned upstream AX runner from source, preserves the upstream
`/usr/local/bin/ax-task-runner` entrypoint contract, and layers Paseo onto the runner runtime. Like
the ordinary Paseo daemon image, it does not promise that every third-party agent CLI is bundled.
Build a derived image when a provider requires an additional executable:

```Dockerfile
FROM ghcr.io/fijimunkii/paseo-ax:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code
```

The pinned upstream runner is currently built for linux/amd64, so Paseo's AX image is built for
linux/amd64 until AX documents and supports an additional runner architecture.

## Security notes

- Paseo relay traffic remains end-to-end encrypted.
- AX guest debug services remain disabled throughout provisioning and normal operation.
- Pairing bootstrap is protected by a random one-time token and becomes permanently unavailable after
  the first successful retrieval.
- Provider credentials are not placed in generated AX manifests.
- Provider login/config belongs in the durable isolated home inside the AX workspace.
- Gateway egress should be kept as narrow as the workload permits.
- One AX Task is one Paseo host/trust boundary in this implementation.
