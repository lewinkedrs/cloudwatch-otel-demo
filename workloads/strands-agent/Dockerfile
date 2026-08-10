# Strands AI Agent Demo - Container Image
# Runs a Bedrock-powered AI agent with OTel observability instrumentation.

FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install dependencies first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY agent.py .

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash agentuser
USER agentuser

# Default environment variables (overridden by K8s deployment)
ENV OTEL_EXPORTER_OTLP_ENDPOINT="http://adot-collector.otel-demo:4318" \
    OTEL_SERVICE_NAME="strands-agent-demo" \
    AGENT_LOOP_INTERVAL="60" \
    PYTHONUNBUFFERED="1"

# Run the agent
CMD ["python", "agent.py"]
