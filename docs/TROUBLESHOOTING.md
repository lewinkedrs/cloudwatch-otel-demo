# Troubleshooting / Lessons learned

Everything below was hit while getting this demo working end-to-end. Each entry
is **symptom → root cause → fix**. Most fixes are already in the code; a couple
of operational items are called out as **outstanding**.

## Infrastructure / deploy

### Managed scraper `CREATE_FAILED`: `400 Invalid Prometheus scrape configuration`
The scrape config was built with a JS string containing literal `\n`
(backslash-n) instead of real newlines, so APS received unparseable YAML.
**Fix:** build the YAML with an array `.join('\n')` (see `scrapeConfigYaml` in
`lib/zeus-demo-stack.ts`).

### Managed scraper `403`: `not authorized to perform: eks:CreateAccessEntry`
The APS `CreateScraper` API auto-provisions an EKS **access entry** for the
scraper, so the calling Lambda role needs the access-entry actions.
**Fix:** grant `eks:CreateAccessEntry`/`DeleteAccessEntry`/`DescribeAccessEntry`/
`AssociateAccessPolicy`/… on the cluster to `ScraperLambdaRole`. This also means
**no manual scraper access-entry step** is required post-deploy.

### CloudWatch agent CrashLoopBackOff: `AssumeRoleWithWebIdentity ... InvalidIdentityToken`
The CloudWatch Observability add-on was configured with
`serviceAccountRoleArn`, which annotates its service account for **IRSA** — but
this cluster has **no OIDC provider**, so the agent tries web-identity auth and
crashes.
**Fix:** remove `serviceAccountRoleArn` from the `CfnAddon`. The agent then uses
the **node role via IMDS**. After changing it, **delete the existing agent pods**
so they lose the stale injected `AWS_ROLE_ARN`/`AWS_WEB_IDENTITY_TOKEN_FILE` env.

### ADOT collector / Bedrock: `no EC2 IMDS role found` / creds time out from pods
Pods couldn't reach IMDS because the node **IMDS hop limit was 1** (a pod is one
extra hop). **Fix:** set the instance metadata **hop limit to 2**.
**⚠ Outstanding:** this is currently applied on the running nodes only
(`aws ec2 modify-instance-metadata-options --http-put-response-hop-limit 2`) and
is **not in the CDK** — a node replacement reverts it. Bake it in via a launch
template on the node group for durability.

## Container image builds

### Python pods CrashLoopBackOff: `exec /usr/local/bin/python: exec format error`
Images were built on Apple Silicon (arm64) but nodes are amd64.
**Fix:** set `platform: Platform.LINUX_AMD64` on the Python `DockerImageAsset`s.
(The Go app hardcodes `GOARCH=amd64` so it was unaffected.)

### `docker login`/build fails with `500 Internal Server Error ... /auth`
Local Docker Desktop's auth subsystem wedged (also 500s on image pulls).
**Fix:** restart Docker Desktop (CLI/AppleScript restart may be blocked by macOS
automation permissions — restart from the menu bar).

## Strands agent

### `ImportError: cannot import name 'StrandsTelemetry'`
`strands-agents==0.1.5` doesn't have `StrandsTelemetry`; the code targeted a
newer API. **Fix:** use the 0.1.5 API `strands.telemetry.tracer.get_tracer(...)`.

### Bedrock `ValidationException: ... on-demand throughput isn't supported` / model is Legacy
`anthropic.claude-sonnet-4-20250514-v1:0` requires a cross-region **inference
profile**, and Sonnet 4 (May 2025) later became Legacy/blocked.
**Fix:** use `us.anthropic.claude-sonnet-4-5-20250929-v1:0` and add
`arn:aws:bedrock:*:<acct>:inference-profile/*` to the node role's Bedrock policy
(in addition to `foundation-model/*`).

### Strands sessions missing from GenAI/AgentCore console
Spans had `session.id` + `gen_ai.*` but not the resource attribute the console
filters on. **Fix:** add `aws.service.type=gen_ai_agent` to
`OTEL_RESOURCE_ATTRIBUTES` (Strands 0.1.5 merges that env into its Resource).
See ARCHITECTURE.md for the officially-supported ADOT-SDK path and why we didn't
use it (would require a Strands upgrade).

## Telemetry not appearing

### Coding Agent Insights (Claude Code) empty
The simulator emitted invented metric names and `service.name=claude-code-simulator`.
The dashboard queries Claude Code's **exact native schema**.
**Fix:** rewrite `simulator.py` to emit `claude_code.token.usage`,
`claude_code.cost.usage`, `claude_code.session.count`,
`claude_code.lines_of_code.count`, `claude_code.code_edit_tool.decision`,
`claude_code.commit.count`, `claude_code.pull_request.count`,
`claude_code.active_time.total`, with `service.name=claude-code`, meter
`com.anthropic.claude_code`, and delta temporality.

### OTel-demo services emit no traces
Overriding the Helm chart's `default.env` **dropped the chart's own
`OTEL_COLLECTOR_NAME`**, so each service's `http://$(OTEL_COLLECTOR_NAME):4317`
endpoint was unresolved.
**Fix:** re-add `OTEL_COLLECTOR_NAME=adot-collector` (first, so K8s substitutes
it into later env values).

### App Signals shows `unknown_service:<runtime>`
Same class of bug: overriding `default.env` dropped the chart's
`OTEL_SERVICE_NAME` Downward-API entry, so services fell back to
`unknown_service:<exe>`.
**Fix:** restore
`OTEL_SERVICE_NAME` via `valueFrom.fieldRef` →
`metadata.labels['app.kubernetes.io/component']`.

> **General rule:** when overriding a Helm chart's `default.env` in CDK,
> **preserve env vars the chart uses for internal substitution**
> (`OTEL_COLLECTOR_NAME`, `OTEL_SERVICE_NAME`, …). A list override replaces the
> chart's defaults wholesale.

### Scraper metrics "missing" from `cloudwatch list-metrics`
Not missing — OTLP metrics ingested into CloudWatch are **not** exposed by
`list-metrics`/`get-metric-data`. Query with PromQL against the SigV4
`monitoring` endpoint (`/api/v1/query`). See VERIFICATION.md and
`scripts/verify-telemetry.sh`.

## Cosmetic / known-minor
- `image-provider` and `telemetry-docs` (upstream OTel-demo nginx) crashloop on
  an `otel_service_name` nginx-config bug in the chart. Not part of the demo
  signals.
- Node count can drop from 4 → 2 (~$220/mo saved); total pod requests fit.
