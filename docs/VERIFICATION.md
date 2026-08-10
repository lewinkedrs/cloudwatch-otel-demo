# Verification

Run `./scripts/verify-telemetry.sh` for a quick automated check, or use the
per-signal steps below. Allow a few minutes after deploy for data to appear.

## 1. Pods healthy

```bash
kubectl get pods -A | grep -E 'otel-demo|claude-code|agent-observability|prom-app-demo|amazon-cloudwatch'
```
Expected: ADOT collector, claude-code-simulator, strands-agent, 2× prom-go-app,
the `cloudwatch-agent` DaemonSet, and the OTel-demo services all `Running`.
(Two upstream OTel-demo nginx pods — `image-provider`, `telemetry-docs` — may
crashloop on an upstream chart bug; cosmetic, not part of the demo signals.)

## 2. Container Insights
Console: **CloudWatch → Insights → Container Insights** → cluster
`zeus-otel-demo`. Confirm log groups exist:
```bash
aws logs describe-log-groups --log-group-name-prefix /aws/containerinsights/zeus-otel-demo \
  --region "$AWS_DEFAULT_REGION" --query 'logGroups[].logGroupName' --output text
```

## 3. Coding Agent Insights (Claude Code)
Console: **CloudWatch → GenAI Observability → Coding Agent Insights → Claude Code**.
The simulator emits the **native** schema (`claude_code.token.usage`,
`claude_code.cost.usage`, `claude_code.session.count`, …) with
`service.name=claude-code` across a 5-developer / 3-team fleet.

## 4. GenAI Observability — Strands agent (Bedrock AgentCore tab)
Console: **CloudWatch → GenAI Observability → Bedrock AgentCore → All sessions / traces**.
Sessions appear because Strands spans carry `session.id`, `gen_ai.*`, and
`aws.service.type=gen_ai_agent`. Confirm spans reached Transaction Search:
```bash
# CloudWatch Logs Insights on the aws/spans log group:
#   fields resource.attributes.service.name, attributes.session.id
#   | filter resource.attributes.aws.service.type = "gen_ai_agent"
```

## 5. Distributed traces / Application Signals
Console: **CloudWatch → Application Signals → Services**, and **X‑Ray → Transaction
Search**. ~35 named services should appear (`frontend`, `cart`, `checkout`,
`shipping`, `payment`, `strands-agent-demo`, …). Service names come from the
`OTEL_SERVICE_NAME` Downward‑API env restored in the Helm values.

## 6. Managed scraper metrics (PromQL)
**These are OTLP metrics — they do NOT show in `cloudwatch list-metrics`.**
Query them with PromQL.

Console: **CloudWatch → Metrics → Query with PromQL (Query Studio)**:
```promql
app_info
sum(rate(http_requests_total[5m]))
```

HTTP API (SigV4, service `monitoring`):
```
GET https://monitoring.<region>.amazonaws.com/api/v1/query?query=app_info
```
`scripts/verify-telemetry.sh` runs this signed query for you. Metric names to
look for: `app_info` (should be `1` per prom-go-app pod), `http_requests_total`,
`http_requests_in_flight`, `http_request_duration_seconds_bucket|_count|_sum`.
Scope with OTLP labels, e.g.:
```promql
{"http_requests_total", "@resource.k8s.namespace.name"="prom-app-demo"}
```
