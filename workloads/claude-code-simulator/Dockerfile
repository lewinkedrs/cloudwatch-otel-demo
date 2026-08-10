# Claude Code Telemetry Simulator
# Generates realistic OTel metrics mimicking Claude Code usage patterns.
# Sends metrics via OTLP HTTP to an ADOT collector in-cluster.

FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY simulator.py .

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

# Run the simulator
CMD ["python", "-u", "simulator.py"]
