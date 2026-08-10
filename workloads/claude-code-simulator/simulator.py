"""
Claude Code Telemetry Simulator

Emits OpenTelemetry metrics that match Claude Code's *native* metric schema so
that Amazon CloudWatch's Coding Agent Insights -> Claude Code dashboard
populates. The dashboard queries the exact metric names, units, attributes and
resource shape that Claude Code produces, so this simulator must match them.

References:
  - https://docs.claude.com/en/docs/claude-code/monitoring-usage
  - https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/coding-agents-claude-code.html

Key requirements the dashboard relies on:
  * resource attribute service.name = "claude-code"
  * meter name = "com.anthropic.claude_code"
  * metric names exactly:
      claude_code.session.count            (count)
      claude_code.token.usage              (tokens)   attrs: type, model
      claude_code.cost.usage               (USD)      attrs: model
      claude_code.lines_of_code.count      (count)    attrs: type, model
      claude_code.code_edit_tool.decision  (count)    attrs: tool_name, decision, language
      claude_code.commit.count             (count)
      claude_code.pull_request.count       (count)
      claude_code.active_time.total        (s)        attrs: type
  * identity/org attributes (user.id, user.email, department, team.id,
    cost_center, organization) sent as OTel *resource* attributes.
  * delta temporality (Claude Code's default).

To make the fleet dashboards interesting, this simulator emulates several
developers across a couple of teams: each developer gets its own MeterProvider
with its own resource identity, all exporting to the same ADOT collector.
"""

import os
import sys
import signal
import time
import uuid
import random
import logging

from opentelemetry import metrics
from opentelemetry.sdk.metrics import (
    Counter,
    Histogram,
    MeterProvider,
    ObservableCounter,
    ObservableGauge,
    ObservableUpDownCounter,
    UpDownCounter,
)
from opentelemetry.sdk.metrics.export import (
    AggregationTemporality,
    PeriodicExportingMetricReader,
)
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.resources import Resource

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

_running = True

# Claude Code exports metric counters using DELTA temporality by default; the
# Coding Agent Insights dashboard expects that shape.
_DELTA_TEMPORALITY = {
    Counter: AggregationTemporality.DELTA,
    UpDownCounter: AggregationTemporality.CUMULATIVE,
    Histogram: AggregationTemporality.DELTA,
    ObservableCounter: AggregationTemporality.DELTA,
    ObservableUpDownCounter: AggregationTemporality.CUMULATIVE,
    ObservableGauge: AggregationTemporality.CUMULATIVE,
}

# Meter name used by real Claude Code.
_METER_NAME = "com.anthropic.claude_code"

# Models Claude Code reports (current, non-legacy identifiers).
_MODELS = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"]

_LANGUAGES = ["TypeScript", "Python", "Go", "JavaScript", "Markdown", "Java"]
_EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"]

# Simulated developer fleet across a few teams/departments. These become OTel
# *resource* attributes so the dashboard can group by user / team / department.
_FLEET = [
    {
        "user.id": "u-1001",
        "user.email": "alice@olympus-corp.example",
        "user.name": "Alice_Nguyen",
        "department": "engineering",
        "team.id": "platform",
        "cost_center": "cc-eng-001",
        "organization": "olympus-corp",
    },
    {
        "user.id": "u-1002",
        "user.email": "bob@olympus-corp.example",
        "user.name": "Bob_Martinez",
        "department": "engineering",
        "team.id": "platform",
        "cost_center": "cc-eng-001",
        "organization": "olympus-corp",
    },
    {
        "user.id": "u-2001",
        "user.email": "carol@olympus-corp.example",
        "user.name": "Carol_Singh",
        "department": "engineering",
        "team.id": "payments",
        "cost_center": "cc-eng-002",
        "organization": "olympus-corp",
    },
    {
        "user.id": "u-2002",
        "user.email": "dan@olympus-corp.example",
        "user.name": "Dan_OBrien",
        "department": "engineering",
        "team.id": "payments",
        "cost_center": "cc-eng-002",
        "organization": "olympus-corp",
    },
    {
        "user.id": "u-3001",
        "user.email": "erin@olympus-corp.example",
        "user.name": "Erin_Wallace",
        "department": "data-science",
        "team.id": "ml-tooling",
        "cost_center": "cc-ds-001",
        "organization": "olympus-corp",
    },
]

# Approximate per-token pricing ($/token) for the cost metric.
_INPUT_TOKEN_COST = 0.003 / 1000
_OUTPUT_TOKEN_COST = 0.015 / 1000
_CACHE_READ_COST = 0.0003 / 1000
_CACHE_WRITE_COST = 0.00375 / 1000


def _shutdown_handler(signum, frame):
    global _running
    logger.info(f"Received signal {signum}, shutting down gracefully...")
    _running = False


class DeveloperAgent:
    """Represents one simulated Claude Code developer with its own OTel pipeline."""

    def __init__(self, identity: dict, otlp_endpoint: str):
        self.identity = identity
        self.session_id = str(uuid.uuid4())

        # service.name MUST be "claude-code" for the dashboard to recognise it.
        resource = Resource.create(
            {
                "service.name": "claude-code",
                "service.version": "2.1.44",
                "os.type": "linux",
                "host.arch": "amd64",
                **identity,
            }
        )

        exporter = OTLPMetricExporter(
            endpoint=f"{otlp_endpoint}/v1/metrics",
            preferred_temporality=_DELTA_TEMPORALITY,
        )
        reader = PeriodicExportingMetricReader(
            exporter, export_interval_millis=30000
        )
        self.provider = MeterProvider(resource=resource, metric_readers=[reader])
        meter = self.provider.get_meter(_METER_NAME)

        # --- Native Claude Code metric instruments ---
        self.session_count = meter.create_counter(
            "claude_code.session.count",
            description="Count of CLI sessions started",
        )
        self.token_usage = meter.create_counter(
            "claude_code.token.usage",
            unit="tokens",
            description="Number of tokens used",
        )
        self.cost_usage = meter.create_counter(
            "claude_code.cost.usage",
            unit="USD",
            description="Cost of the Claude Code session",
        )
        self.lines_of_code = meter.create_counter(
            "claude_code.lines_of_code.count",
            description="Count of lines of code modified",
        )
        self.code_edit_decision = meter.create_counter(
            "claude_code.code_edit_tool.decision",
            description="Count of code editing tool permission decisions",
        )
        self.commit_count = meter.create_counter(
            "claude_code.commit.count",
            description="Number of git commits created",
        )
        self.pull_request_count = meter.create_counter(
            "claude_code.pull_request.count",
            description="Number of pull requests created",
        )
        self.active_time = meter.create_counter(
            "claude_code.active_time.total",
            unit="s",
            description="Total active time",
        )

        # New session at startup.
        self.session_count.add(1, {"start_type": "fresh", "session.id": self.session_id})

    def _base_attrs(self, model: str) -> dict:
        return {"model": model, "session.id": self.session_id}

    def emit_cycle(self):
        """Emit one cycle of realistic Claude Code activity for this developer."""
        # Occasionally roll a brand-new session.
        if random.random() < 0.15:
            self.session_id = str(uuid.uuid4())
            self.session_count.add(
                1,
                {
                    "start_type": random.choice(["fresh", "resume", "continue"]),
                    "session.id": self.session_id,
                },
            )

        model = random.choice(_MODELS)
        base = self._base_attrs(model)

        # Token usage by type.
        input_tokens = random.randint(800, 8000)
        output_tokens = random.randint(200, 3000)
        cache_read = random.randint(0, 20000)
        cache_creation = random.randint(0, 4000)
        self.token_usage.add(input_tokens, {**base, "type": "input"})
        self.token_usage.add(output_tokens, {**base, "type": "output"})
        self.token_usage.add(cache_read, {**base, "type": "cacheRead"})
        self.token_usage.add(cache_creation, {**base, "type": "cacheCreation"})

        # Cost derived from token usage.
        cost = (
            input_tokens * _INPUT_TOKEN_COST
            + output_tokens * _OUTPUT_TOKEN_COST
            + cache_read * _CACHE_READ_COST
            + cache_creation * _CACHE_WRITE_COST
        )
        self.cost_usage.add(cost, base)

        # Lines of code added / removed.
        self.lines_of_code.add(
            random.randint(0, 120), {**base, "type": "added"}
        )
        self.lines_of_code.add(
            random.randint(0, 60), {**base, "type": "removed"}
        )

        # Code edit tool permission decisions.
        for _ in range(random.randint(1, 6)):
            decision = "accept" if random.random() < 0.85 else "reject"
            self.code_edit_decision.add(
                1,
                {
                    "tool_name": random.choice(_EDIT_TOOLS),
                    "decision": decision,
                    "source": "config" if decision == "accept" else "user_reject",
                    "language": random.choice(_LANGUAGES),
                },
            )

        # Commits / PRs happen occasionally.
        if random.random() < 0.4:
            self.commit_count.add(random.randint(1, 3))
        if random.random() < 0.15:
            self.pull_request_count.add(1)

        # Active time (seconds) split between user interaction and CLI processing.
        self.active_time.add(random.uniform(20, 90), {"type": "user"})
        self.active_time.add(random.uniform(10, 120), {"type": "cli"})

        logger.info(
            "emit | user=%s team=%s model=%s | in=%d out=%d cacheR=%d cacheC=%d | cost=$%.4f",
            self.identity["user.id"],
            self.identity["team.id"],
            model,
            input_tokens,
            output_tokens,
            cache_read,
            cache_creation,
            cost,
        )

    def shutdown(self):
        try:
            self.provider.shutdown()
        except Exception as e:  # pragma: no cover - best effort on shutdown
            logger.warning(f"Error shutting down provider for {self.identity['user.id']}: {e}")


def main():
    logger.info("Starting Claude Code Telemetry Simulator (native schema)...")

    signal.signal(signal.SIGTERM, _shutdown_handler)
    signal.signal(signal.SIGINT, _shutdown_handler)

    otlp_endpoint = os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT", "http://adot-collector.otel-demo:4318"
    )
    logger.info(f"OTLP endpoint: {otlp_endpoint}")
    logger.info(f"Simulating a fleet of {len(_FLEET)} developers")

    agents = [DeveloperAgent(identity, otlp_endpoint) for identity in _FLEET]

    cycle = 0
    try:
        while _running:
            cycle += 1
            logger.info(f"--- Cycle {cycle} ---")
            for agent in agents:
                if not _running:
                    break
                agent.emit_cycle()

            # Sleep ~30s, responsive to shutdown.
            for _ in range(30):
                if not _running:
                    break
                time.sleep(1)
    finally:
        logger.info("Shutting down all developer providers...")
        for agent in agents:
            agent.shutdown()
        logger.info("Shutdown complete.")


if __name__ == "__main__":
    main()
