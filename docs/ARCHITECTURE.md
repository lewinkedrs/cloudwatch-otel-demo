# Architecture

## Telemetry flows

| Signal | Producer | Path to CloudWatch | Auth |
|---|---|---|---|
| Container Insights | CloudWatch Observability add-on (`cloudwatch-agent` DaemonSet) | Agent → CloudWatch (Container Insights) + Logs | Node instance role (IMDS) |
| Coding Agent Insights | `claude-code-simulator` | OTLP → **ADOT collector** → CloudWatch metrics OTLP endpoint | Collector SigV4 (node role) |
| Distributed traces / App Signals | OpenTelemetry Demo services | OTLP (gRPC :4317) → **ADOT collector** → X‑Ray (Transaction Search) | Collector SigV4 (node role) |
| GenAI / AgentCore | `strands-agent` | OTLP → **ADOT collector** → X‑Ray; spans carry `aws.service.type=gen_ai_agent` | Collector SigV4 (node role) |
| PromQL metrics | `prom-go-app` | **APS managed scraper** (in-VPC) → CloudWatch (`cloudWatchConfiguration`) | Scraper service-linked role |

The **ADOT collector** (`otel-demo` namespace) is the hub for in-cluster
workloads. It listens on OTLP `:4317` (gRPC) and `:4318` (HTTP) and exports with
SigV4 to three destinations:

- `otlphttp/traces` → `https://xray.<region>.amazonaws.com` (Transaction Search)
- `otlphttp/metrics` → `https://monitoring.<region>.amazonaws.com`
- `otlphttp/logs` → `https://logs.<region>.amazonaws.com`

The **managed scraper is agentless** — it runs in the AWS service account, gets
an ENI in the cluster VPC/subnets, discovers pods via the Kubernetes API
(`role: pod`), scrapes `:8080/metrics`, and writes to the CloudWatch metrics
dataset. Those metrics are **not** visible in `cloudwatch list-metrics`; query
them with PromQL (see VERIFICATION.md).

## Key design decisions

### No IRSA / no OIDC provider — pods use the node role via IMDS
The cluster intentionally has **no OIDC provider and no IRSA**. Every pod that
needs AWS credentials (ADOT collector, CloudWatch agent, Strands→Bedrock) uses
the **EC2 node instance role** through IMDS.

Consequences baked into the stack:
- The node group's **IMDS hop limit must be 2** (a pod is one extra network hop
  from `169.254.169.254`; the EC2 default of 1 blocks pods). *This is currently
  applied operationally on the nodes and is **not yet in the CDK** — a node
  replacement reverts it. See TROUBLESHOOTING.md → "Bake IMDS hop limit into IaC".*
- The CloudWatch Observability add-on must **not** set `serviceAccountRoleArn`
  (that would trigger IRSA `AssumeRoleWithWebIdentity`, which fails with no OIDC).
- All IAM permissions the workloads need are attached to the **node group role**
  (`CloudWatchAgentServerPolicy`, `AWSXrayWriteOnlyAccess`, Bedrock invoke on
  `foundation-model/*` **and** `inference-profile/*`, plus the scraper Lambda's
  EKS access-entry perms).

### Shared collector vs. direct-to-CloudWatch
In-cluster app telemetry flows through the shared ADOT collector so there's one
SigV4 egress path and one place to add resource attributes. The **CloudWatch
agent** (Container Insights) and the **managed scraper** talk to CloudWatch
directly because they're AWS-managed components.

> **Note on the fully-supported AgentCore path:** AWS documents that agents
> hosted outside AgentCore should use the **ADOT SDK** (`aws-opentelemetry-distro`
> + `opentelemetry-instrument`, `AGENT_OBSERVABILITY_ENABLED=true`) sending
> **directly** to CloudWatch — the ADOT *collector* is officially "not supported"
> for agent observability. This demo instead keeps Strands on the shared
> collector and tags spans `aws.service.type=gen_ai_agent`, which is what the
> GenAI/AgentCore console filters on, so sessions/traces populate. The pinned
> `strands-agents==0.1.5` manages its own tracer provider and does not defer to
> the ADOT SDK's global provider, so the direct-SDK path would require a Strands
> upgrade. See TROUBLESHOOTING.md.

### Single NAT gateway
`natGateways: 1` (down from 2) to stay within the account EIP quota and reduce
cost. Fine for a demo; not HA.
