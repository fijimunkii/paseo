# Decision engines

Paseo can use an external decision engine for bounded control-plane judgments: authorizing a
daemon-owned operation, selecting an execution lane, or deciding what an agent loop should do next.
Decision engines are control-plane inputs. They are not agent providers and they do not execute
tools, write code, or replace deterministic verification.

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

The first enforced authorization operation is the daemon-owned `create_agent` tool. The gate runs
after strict, side-effect-free normalization of the request but before workspace creation, worktree
creation, or `AgentManager.createAgent`. Compatibility syntax is normalized to the same semantic
operation before fingerprinting, so unknown fields or legacy aliases cannot be used to force new
samples.

Jev can also drive opt-in orchestration. Paseo asks server-owned task/checkpoint questions, maps the
answers to abstract execution lanes or loop directives in deterministic code, validates lane targets
against the live provider catalog, and applies the result only at daemon-owned runtime boundaries.
The worker model never chooses the rubric, confidence threshold, retry budget, or lane mapping.

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

Orchestration task assessment sends only the task/title plus the requested provider, model, and
thinking option. Checkpoint assessment sends bounded evidence selected by Paseo: turn status, recognized
verification results, deduplicated failure signatures, bounded changed-file paths, and git
dirty/diff-count facts. Worker-authored completion prose is deliberately excluded from the
checkpoint identity so rephrasing a final answer cannot force a fresh Jev sample. Paseo does not
send raw shell output, raw diffs, arbitrary timeline entries, or repository contents to Jev. In enforce mode, deterministic facts are handled before Jev:
for example, a failed check triggers recovery and missing verification triggers `VERIFY` without a
checkpoint model call.

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

## Managed orchestration

Orchestration is disabled by default and its default routing mode is `manual`. Enabling the policy
does not silently override explicit settings unless managed routing is selected by configuration or
request.

A provider-neutral lane configuration looks like:

```json
{
  "decisions": {
    "mode": "shadow",
    "typesafe": {
      "enabled": true,
      "model": "jev-latest"
    },
    "policies": {
      "orchestration": {
        "enabled": true,
        "defaultRouting": "manual",
        "minimumConfidence": 0.85,
        "failureDisposition": "review",
        "maxAttempts": 3,
        "maxEscalations": 1,
        "lanes": {
          "small": {
            "provider": "codex",
            "model": "<fast-model>",
            "thinkingOptionId": "low"
          },
          "medium": {
            "provider": "codex",
            "model": "<fast-model>",
            "thinkingOptionId": "medium"
          },
          "high": {
            "provider": "codex",
            "model": "<fast-model>",
            "thinkingOptionId": "high"
          },
          "escalated": {
            "provider": "codex",
            "model": "<strong-model>",
            "thinkingOptionId": "high"
          }
        }
      }
    }
  }
}
```

Jev chooses abstract lanes (`small`, `medium`, `high`, `escalated`), not vendor model names.
Paseo resolves the configured lane against the live provider/model/thinking-option catalog. At the
current `create_agent` and existing-agent prompt boundaries, managed routing may change model and
thinking level only within the already selected provider; a configured cross-provider lane fails
closed instead of silently switching providers.

For `create_agent`, set `settings.orchestration` to `managed` to opt the request in. For
`send_agent_prompt`, set the top-level `orchestration` field to `managed`. If
`defaultRouting` is `managed`, omission inherits that daemon policy. Background calls receive
task-start routing only. The bounded checkpoint/retry loop runs only for blocking calls, so Paseo
does not create hidden autonomous work behind a caller that requested background execution.

After a blocking managed turn, Paseo builds deterministic evidence from observed tool results and
git facts. The loop directive is one of:

```text
CONTINUE | RETRY | VERIFY | ESCALATE | COMPLETE | REVIEW
```

Hard rules run first:

- permission/attention or an unresolved running state => `REVIEW`
- failed turn or failed deterministic check => bounded recovery; never `COMPLETE`
- no recognized verification => `VERIFY`
- implementation retry/escalation budgets are enforced in code; verification-only turns do not
  consume the implementation-attempt budget
- only direct, unmasked verification commands count as deterministic evidence; shell chaining,
  wrappers, redirection, or constructs such as `npm test || true` are not trusted
- `COMPLETE` is accepted only after deterministic verification has passed

Only after those deterministic facts clear does enforce mode ask Jev for residual semantic judgment.
Shadow mode may still evaluate the checkpoint for comparison but never performs the recommended
continuation, retry, escalation, or completion branch.

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

The same anti-resampling rule applies to orchestration. Attempt counters and retry-loop position are
not included merely to create another probabilistic sample. A fresh checkpoint sample requires
meaningfully changed Jev-visible evidence, such as changed verification results, failure signatures,
git facts, task state, policy, or model.

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
- optional bounded orchestration application history: requested provider/model/thinking tuple,
  Jev-recommended lane/directive, Paseo-applied lane/directive, attempt/escalation counters, and safe
  evidence summaries (check statuses, changed-path count, failure-signature count, and git diff counts)

The record does not contain the decision state, task prompt, operation payload, raw diff, raw shell
output, worker completion prose, or API key.

The decision fingerprint binds the code-owned Jev-visible state to the definition, deterministic
policy version/configuration, engine availability, endpoint, requested model, threshold, failure
behavior, and mode. Local-only operation fields that Jev cannot see do not create fresh model
samples. Configuration or Jev-visible state changes create a new decision identity.

An allow produces an in-memory, short-lived, single-use permit that carries the decision
fingerprint, complete normalized-operation fingerprint, concrete returned model, and `allow`
disposition. The enforcement boundary consumes that permit against the exact operation before
proceeding. A mismatch in any bound permit metadata burns the permit; an expired or already consumed
permit cannot be reused.
