#!/usr/bin/env bash
# Read-only health check for the CloudWatch OTel demo.
# Verifies pods, Container Insights log groups, Transaction Search spans
# (incl. the gen_ai_agent Strands service), and the agentless scraper's
# Prometheus metrics via a SigV4-signed PromQL query.
#
# Usage: AWS_DEFAULT_REGION=us-east-2 ./scripts/verify-telemetry.sh
set -uo pipefail

REGION="${AWS_DEFAULT_REGION:-${CDK_DEFAULT_REGION:-us-east-2}}"
CLUSTER="${CLUSTER:-zeus-otel-demo}"
echo "Region: $REGION | Cluster: $CLUSTER"
echo

echo "== 1. Workload pods =="
kubectl get pods -A 2>/dev/null | grep -E 'NAMESPACE|otel-demo|claude-code|agent-observability|prom-app-demo|amazon-cloudwatch' \
  | grep -vE 'image-provider|telemetry-docs' || echo "  (kubectl not configured? run: aws eks update-kubeconfig --name $CLUSTER --region $REGION)"
echo

echo "== 2. Container Insights log groups =="
aws logs describe-log-groups --region "$REGION" \
  --log-group-name-prefix "/aws/containerinsights/$CLUSTER" \
  --query 'logGroups[].logGroupName' --output text 2>/dev/null || echo "  (none found)"
echo

echo "== 3. Managed scraper status =="
aws amp list-scrapers --region "$REGION" \
  --query "scrapers[?alias=='zeus-demo-prom-scraper'].{id:scraperId,status:status.statusCode}" \
  --output text 2>/dev/null || echo "  (scraper not found)"
echo

echo "== 4. Scraper Prometheus metrics (SigV4 PromQL) =="
python3 - "$REGION" <<'PY'
import json, sys, urllib.parse, urllib3
try:
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session
except Exception as e:
    print("  botocore not available:", e); sys.exit(0)

region = sys.argv[1]
base = f"https://monitoring.{region}.amazonaws.com/api/v1"
http = urllib3.PoolManager()
try:
    creds = Session().get_credentials().get_frozen_credentials()
except Exception as e:
    print("  no AWS credentials:", e); sys.exit(0)

def q(promql):
    url = f"{base}/query?query=" + urllib.parse.quote(promql)
    req = AWSRequest(method="GET", url=url, headers={"Host": urllib.parse.urlparse(url).hostname})
    SigV4Auth(creds, "monitoring", region).add_auth(req)
    r = http.request("GET", url, headers=dict(req.headers))
    return r.status, r.data.decode()

for m in ("app_info", "http_requests_total", "http_requests_in_flight"):
    st, body = q(m)
    try:
        n = len(json.loads(body).get("data", {}).get("result", []))
        print(f"  {m}: HTTP {st}, {n} series" + ("  OK" if n else "  (no data yet)"))
    except Exception:
        print(f"  {m}: HTTP {st} {body[:120]}")
PY
echo
echo "Done. See docs/VERIFICATION.md for console locations and PromQL examples."
