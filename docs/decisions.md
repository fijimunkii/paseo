# Decision engines

Paseo can use an external decision engine to evaluate a daemon-owned operation before Paseo
performs it. Decision engines are control-plane inputs. They are not agent providers and they do not
execute tools.

Jev / TypeSafe System One is the first decision engine.

## Trust boundary

Decision output is probabilistic. Paseo owns the deterministic policy that maps the output to an
action and owns the boundary where that action is enforced.

The order is:

1. ordinary Paseo capability and tool policy
2. operation construction
3. optional decision-engine evaluation
4. deterministic Paseo policy mapping
5. daemon-owned enforcement

A decision engine never widens authority denied by ordinary Paseo policy.

The first enforced operation is the daemon-owned `create_agent` tool. The gate runs after strict,
side-effect-free normalization of the request but before workspace creation, worktree creation, or
`AgentManager.createAgent`. Compatibility syntax is normalized to the same semantic operation
before fingerprinting, so unknown fields or legacy aliases cannot be used to force new samples.

This does not claim to mediate arbitrary filesystem or shell activity performed inside Claude,
Codex, OpenCode, or another provider. It is a harness policy boundary, not an OS sandbox. An agent
with unrestricted local code execution remains subject to Paseo's ordinary local-daemon trust model
and may be able to reach other local interfaces outside this specific guarded operation.

## External egress

TypeSafe is a hosted service. Enabling a TypeSafe policy sends selected decision state outside the
machine. This is an explicit exception to Paseo's default local-first data path.

No TypeSafe request is made unless all of these are true:

- `decisions` exists in `config.json`
- the relevant policy is enabled
- `decisions.typesafe.enabled` is `true`
- `TYPESAFE_API_KEY` is available to the daemon

Credentials alone do not enable egress. The daemon strips `TYPESAFE_API_KEY` from normal external child-process environments, including agent providers, terminals, and workspace commands.

The `create_agent` policy sends a code-owned projection containing the requested title, provider,
task text, placement fields, and the safe autonomy settings `modeId` / `thinkingOptionId` when
present. It does not forward MCP passthrough fields, labels, arbitrary feature values, or workspace
contents. The Jev-visible state is hashed into a decision fingerprint for sampling/audit reuse;
the complete validated operation is separately hashed for exact permit binding.

TypeSafe documents its service and data terms at:

- https://typesafe.ai/legal/privacy-policy
- https://typesafe.ai/legal/mca

## Configuration

The API key is environment-only:

```sh
export TYPESAFE_API_KEY=...
```

Start in shadow mode:

```json
{
  "version": 1,
  "decisions": {
    "mode": "shadow",
    "typesafe": {
      "enabled": true,
      "model": "jev-latest"
    },
    "policies": {
      "createAgentTool": {
        "enabled": true,
        "minimumConfidence": 0.9,
        "failureDisposition": "review"
      }
    }
  }
}
```

Shadow mode evaluates and audits the decision but does not change execution. A shadow `deny` or
`review` is recorded as the disposition that would have applied while the actual disposition is
`allow`.

Enforce mode requires a pinned model identifier:

```json
{
  "decisions": {
    "mode": "enforce",
    "typesafe": {
      "enabled": true,
      "model": "jev-<pinned-model-id>"
    },
    "policies": {
      "createAgentTool": {
        "enabled": true,
        "minimumConfidence": 0.95,
        "failureDisposition": "deny"
      }
    }
  }
}
```

`jev-latest` is rejected for an enabled enforce policy because a moving alias cannot identify the
model that the policy intended to authorize. Use TypeSafe's `GET /v1/models` endpoint to discover
the model IDs available to the account and configure one of those exact IDs.

Decision configuration is startup configuration in this implementation. Restart the daemon after
changing `decisions` or `TYPESAFE_API_KEY`.

## Failure behavior

An enforce policy never turns a TypeSafe timeout, network error, HTTP error, malformed response,
unavailable credential, audit failure, or pinned-model mismatch into an allow. The configured
`failureDisposition` is either `review` or `deny`. Caller cancellation aborts the operation instead
of being converted into a policy result.

`review` is fail-closed at the current `create_agent` boundary. The tool call stops without side
effects and reports that human review is required. Paseo does not yet create a separate approval
card for decision review.

The TypeSafe transport does not retry `POST /v1/systemone`. Paseo samples one semantic decision for
one decision fingerprint. A recorded result or failure is reused whenever the policy/model and the
Jev-visible state are unchanged, rather than repeatedly querying until an allow appears.

## Audit and replay identity

Decision records are private files under:

```text
$PASEO_HOME/decisions/<decision-fingerprint>.json
```

The record contains:

- definition id, version, and hash
- deterministic policy version and hash
- requested and concrete model
- shadow/enforce mode
- model answers and probabilities
- would-be and actual disposition
- latency and token usage
- safe error kind when evaluation failed
- optional agent/tool identity

The record does not contain the decision state, task prompt, operation payload, or API key.

The decision fingerprint binds the code-owned Jev-visible state to the definition, deterministic
policy version/configuration, engine availability, endpoint, requested model, threshold, failure
behavior, and mode. Local-only operation fields that Jev cannot see do not create fresh model
samples. Configuration or Jev-visible state changes create a new decision identity.

An allow produces an in-memory, short-lived, single-use permit that carries the decision
fingerprint, complete normalized-operation fingerprint, concrete returned model, and `allow`
disposition. The enforcement boundary consumes that permit against the exact operation before
proceeding. A mismatch in any bound permit metadata burns the permit; an expired or already consumed
permit cannot be reused.
