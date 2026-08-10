"""
Strands AI Agent Demo - Observability with OpenTelemetry

This application demonstrates AI agent observability using the Strands agents framework
with OTel instrumentation. It runs a Bedrock-powered agent in a loop, generating varied
trace data (agent spans, cycle spans, model invoke spans, tool spans) that follow
GenAI semantic conventions.

Deployed as a Kubernetes Deployment in the agent-observability namespace.
Sends traces to ADOT collector which forwards to CloudWatch/X-Ray.
"""

import os
import sys
import signal
import time
import uuid
import logging
import random
from datetime import datetime

from strands import Agent, tool
from strands.models.bedrock import BedrockModel
from strands.telemetry.tracer import get_tracer

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("strands-agent-demo")

# Session IDs are minted and rotated inside run_agent_loop() (every
# SESSION_ROTATE_INTERVAL seconds) rather than once per process.

# Flag for graceful shutdown
shutdown_requested = False


def signal_handler(signum, frame):
    """Handle SIGTERM for graceful shutdown in Kubernetes."""
    global shutdown_requested
    logger.info(f"Received signal {signum}, initiating graceful shutdown...")
    shutdown_requested = True


# Register signal handlers for graceful shutdown
signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)


# --- Tool Definitions ---
# These tools are automatically instrumented by the Strands SDK,
# generating tool spans in the trace data.


@tool
def get_weather(city: str) -> str:
    """Get the current weather for a given city.

    Args:
        city: The name of the city to get weather for.

    Returns:
        A string describing the current weather conditions.
    """
    # Simulated weather data for demo purposes
    weather_conditions = [
        {"condition": "sunny", "temp_f": 72, "humidity": 45},
        {"condition": "cloudy", "temp_f": 58, "humidity": 70},
        {"condition": "rainy", "temp_f": 52, "humidity": 85},
        {"condition": "partly cloudy", "temp_f": 65, "humidity": 55},
        {"condition": "clear", "temp_f": 78, "humidity": 30},
    ]
    weather = random.choice(weather_conditions)
    logger.info(f"Tool invoked: get_weather(city={city})")
    return (
        f"Current weather in {city}: {weather['condition']}, "
        f"temperature {weather['temp_f']}°F, humidity {weather['humidity']}%"
    )


@tool
def calculate(expression: str) -> str:
    """Evaluate a mathematical expression safely.

    Args:
        expression: A mathematical expression to evaluate (e.g., '42 * 17 + 3').

    Returns:
        The result of the calculation as a string.
    """
    logger.info(f"Tool invoked: calculate(expression={expression})")
    try:
        # Only allow safe mathematical operations
        allowed_chars = set("0123456789+-*/().% ")
        if not all(c in allowed_chars for c in expression):
            return f"Error: Expression contains invalid characters. Only numbers and +-*/().% are allowed."
        result = eval(expression)  # Safe due to character allowlist above
        return f"Result: {expression} = {result}"
    except Exception as e:
        return f"Error evaluating expression '{expression}': {str(e)}"


@tool
def search_knowledge_base(query: str) -> str:
    """Search a knowledge base for information on a given topic.

    Args:
        query: The search query to look up in the knowledge base.

    Returns:
        A string containing relevant information from the knowledge base.
    """
    logger.info(f"Tool invoked: search_knowledge_base(query={query})")
    # Simulated knowledge base responses for demo purposes
    knowledge_base = {
        "opentelemetry": (
            "OpenTelemetry (OTel) is an open-source observability framework for generating, "
            "collecting, and exporting telemetry data (traces, metrics, logs). It provides "
            "vendor-neutral APIs and SDKs for instrumentation. Key concepts include: spans "
            "(units of work), traces (end-to-end request flows), and semantic conventions "
            "(standardized attribute naming). OTel supports auto-instrumentation and manual "
            "instrumentation across many languages including Python, Java, and Go."
        ),
        "strands": (
            "Strands Agents is a framework for building AI agents with built-in observability. "
            "It provides automatic OTel instrumentation generating agent spans, cycle spans, "
            "model invoke spans, and tool spans following GenAI semantic conventions."
        ),
        "bedrock": (
            "Amazon Bedrock is a fully managed service that provides access to foundation models "
            "from leading AI companies through a single API. It supports models like Claude, "
            "Titan, and others for text generation, embeddings, and image generation."
        ),
    }

    # Find the best matching entry
    query_lower = query.lower()
    for key, value in knowledge_base.items():
        if key in query_lower:
            return f"Knowledge base result for '{query}': {value}"

    return (
        f"Knowledge base result for '{query}': No specific entry found. "
        f"The knowledge base contains information about: {', '.join(knowledge_base.keys())}."
    )


def setup_telemetry():
    """Configure OpenTelemetry with OTLP HTTP exporter for trace collection.

    Sets up the StrandsTelemetry exporter to send traces to the ADOT collector.
    Resource attributes include service name, environment, and session ID.
    """
    otel_endpoint = os.getenv(
        "OTEL_EXPORTER_OTLP_ENDPOINT", "http://adot-collector.otel-demo:4318"
    )

    # Set OTel resource attributes via environment variables
    # These are picked up by the OTel SDK for resource identification
    os.environ.setdefault("OTEL_SERVICE_NAME", "strands-agent-demo")
    os.environ.setdefault(
        "OTEL_RESOURCE_ATTRIBUTES",
        # aws.service.type=gen_ai_agent is the resource attribute CloudWatch GenAI
        # (Bedrock AgentCore) Observability filters on to surface agent
        # sessions/traces. session.id is intentionally NOT set here: it's a
        # per-session SPAN attribute (on the Agent's trace_attributes) that the
        # loop rotates over time so the sessions view keeps populating.
        "service.name=strands-agent-demo,environment=olympus,"
        "aws.service.type=gen_ai_agent",
    )

    logger.info(f"Configuring OTel telemetry with endpoint: {otel_endpoint}")
    logger.info(f"Service name: strands-agent-demo")
    logger.info(f"Environment: olympus")

    # Initialize Strands telemetry with OTLP HTTP exporter (strands-agents 0.1.5 API).
    # get_tracer() configures the global TracerProvider and appends /v1/traces to the
    # endpoint automatically, so agent/tool spans are exported to the ADOT collector.
    tracer = get_tracer(
        service_name="strands-agent-demo",
        otlp_endpoint=otel_endpoint,
    )

    return tracer


def create_agent(session_id):
    """Create and configure the Strands Agent with Bedrock model and tools.

    Uses Amazon Bedrock Claude Sonnet as the underlying model. AWS credentials
    come from the node instance role via IMDS (default boto3 credential chain).
    The session_id is stamped as a span trace attribute so CloudWatch GenAI
    Observability groups this agent's traces into a session.
    """
    # Configure the Bedrock model - uses default credential chain (node role/IMDS)
    model = BedrockModel(
        model_id=os.getenv("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0"),
        region_name=os.getenv("AWS_REGION", os.getenv("AWS_DEFAULT_REGION", "us-west-2")),
    )

    # Create the agent with tools and trace attributes for observability
    agent = Agent(
        model=model,
        tools=[get_weather, calculate, search_knowledge_base],
        trace_attributes={
            "session.id": session_id,
            "user.id": os.getenv("AGENT_USER_ID", "demo@olympus-corp.example"),
            "environment": "olympus",
        },
        system_prompt=(
            "You are a helpful AI assistant with access to weather, calculation, "
            "and knowledge base search tools. Always use the appropriate tool to "
            "answer questions. Be concise in your responses."
        ),
    )

    logger.info(f"Agent created for session {session_id}")
    return agent


def run_agent_loop():
    """Run the agent in a loop, cycling through questions and rotating sessions.

    Each iteration generates a full trace (agent span -> cycle -> model invoke ->
    tool spans). Every SESSION_ROTATE_INTERVAL seconds (default 300s / 5 min) a
    new session.id is minted and the agent rebuilt, so CloudWatch GenAI
    Observability shows a steady stream of new sessions rather than one long one.

    Runs until shutdown is requested.
    """
    # Questions that exercise different tools to generate varied trace data
    questions = [
        "What's the weather in Seattle?",
        "Calculate 42 * 17 + 3",
        "Search for information about OpenTelemetry",
        "What's the weather in New York City?",
        "Calculate (256 + 128) * 3 - 50",
        "Search for information about Bedrock",
    ]

    iteration = 0
    loop_interval = int(os.getenv("AGENT_LOOP_INTERVAL", "60"))
    rotate_interval = int(os.getenv("SESSION_ROTATE_INTERVAL", "300"))

    session_id = str(uuid.uuid4())
    agent = create_agent(session_id)
    session_start = time.time()
    logger.info(f"Starting agent loop with {loop_interval}s interval, "
                f"rotating session every {rotate_interval}s")
    logger.info(f"Session started: {session_id}")
    logger.info(f"Questions pool size: {len(questions)}")

    while not shutdown_requested:
        # Rotate to a fresh session on schedule (new session.id -> new Agent).
        if time.time() - session_start >= rotate_interval:
            session_id = str(uuid.uuid4())
            agent = create_agent(session_id)
            session_start = time.time()
            logger.info(f"Rotated to new session: {session_id}")

        # Select the next question (cycle through the list)
        question = questions[iteration % len(questions)]
        iteration += 1

        logger.info(f"--- Iteration {iteration} ---")
        logger.info(f"Asking agent: '{question}'")

        try:
            # Invoke the agent - this generates the full trace hierarchy:
            # agent span -> cycle span(s) -> model invoke span + tool span(s)
            start_time = time.time()
            response = agent(question)
            elapsed = time.time() - start_time

            # Log the response summary
            response_text = str(response)
            # Truncate long responses for log readability
            if len(response_text) > 200:
                response_text = response_text[:200] + "..."
            logger.info(f"Agent response ({elapsed:.2f}s): {response_text}")

        except Exception as e:
            logger.error(f"Error during agent invocation: {type(e).__name__}: {e}")

        # Wait for the next iteration, checking for shutdown periodically
        logger.info(f"Waiting {loop_interval}s until next iteration...")
        wait_start = time.time()
        while not shutdown_requested and (time.time() - wait_start) < loop_interval:
            time.sleep(1)

    logger.info("Agent loop terminated gracefully")


def main():
    """Main entry point for the Strands Agent demo application."""
    logger.info("=" * 60)
    logger.info("Strands AI Agent Demo - Starting")
    logger.info(f"Timestamp: {datetime.utcnow().isoformat()}Z")
    logger.info(f"Session rotation: every {os.getenv('SESSION_ROTATE_INTERVAL', '300')}s")
    logger.info("=" * 60)

    # Step 1: Configure OpenTelemetry
    setup_telemetry()

    # Step 2: Run the agent loop (creates the agent and rotates sessions itself)
    run_agent_loop()

    logger.info("Strands AI Agent Demo - Shutdown complete")


if __name__ == "__main__":
    main()
