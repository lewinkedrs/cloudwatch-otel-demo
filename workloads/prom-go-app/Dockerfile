# Kubernetes annotations needed:
# prometheus.io/scrape: "true"
# prometheus.io/port: "8080"
# prometheus.io/path: "/metrics"

# ---- Builder stage ----
FROM golang:1.22-alpine AS builder

# Install git (required for GOPROXY=direct)
RUN apk add --no-cache git

WORKDIR /app

# Use direct proxy to avoid Go module proxy issues
ENV GOPROXY=direct

# Copy go module files first for better layer caching
COPY go.mod go.sum* ./
RUN go mod download

# Copy source code
COPY . .

# Ensure go.sum is up to date and build static binary
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o /app/prom-go-app .

# ---- Runtime stage ----
FROM alpine:3.19

# Install ca-certificates for HTTPS (load generator uses HTTP client)
RUN apk --no-cache add ca-certificates

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/prom-go-app .

# Set ownership
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8080

# Healthcheck on /health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run the binary
ENTRYPOINT ["./prom-go-app"]
