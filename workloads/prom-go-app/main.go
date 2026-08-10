package main

// Kubernetes annotations needed:
// prometheus.io/scrape: "true"
// prometheus.io/port: "8080"
// prometheus.io/path: "/metrics"

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics
var (
	// http_request_duration_seconds — Histogram with custom buckets
	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "Duration of HTTP requests in seconds.",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
		},
		[]string{"method", "path", "status"},
	)

	// http_requests_total — Counter with method, path, status labels
	httpRequestsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests.",
		},
		[]string{"method", "path", "status"},
	)

	// http_requests_in_flight — Gauge for current concurrent requests
	httpRequestsInFlight = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "http_requests_in_flight",
			Help: "Current number of HTTP requests being processed.",
		},
	)

	// app_info — Gauge set to 1 with version and environment labels
	appInfo = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "app_info",
			Help: "Application information.",
		},
		[]string{"version", "environment"},
	)
)

func init() {
	// Register all metrics with the default Prometheus registry
	prometheus.MustRegister(httpRequestDuration)
	prometheus.MustRegister(httpRequestsTotal)
	prometheus.MustRegister(httpRequestsInFlight)
	prometheus.MustRegister(appInfo)

	// Set app_info gauge to 1 with labels
	appInfo.WithLabelValues("1.0.0", "olympus").Set(1)
}

// metricsMiddleware records request duration and counts for all endpoints
func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Track in-flight requests
		httpRequestsInFlight.Inc()
		defer httpRequestsInFlight.Dec()

		// Wrap ResponseWriter to capture status code
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		// Record start time
		start := time.Now()

		// Serve the request
		next.ServeHTTP(wrapped, r)

		// Record duration and count
		duration := time.Since(start).Seconds()
		status := strconv.Itoa(wrapped.statusCode)
		path := r.URL.Path

		httpRequestDuration.WithLabelValues(r.Method, path, status).Observe(duration)
		httpRequestsTotal.WithLabelValues(r.Method, path, status).Inc()
	})
}

// responseWriter wraps http.ResponseWriter to capture the status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Handler: GET / — returns JSON status
func handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := map[string]string{
		"status":      "ok",
		"service":     "prom-go-app",
		"environment": "olympus",
	}
	json.NewEncoder(w).Encode(resp)
}

// Handler: GET /health — returns 200 OK
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "OK")
}

// Handler: GET /slow — simulates slow endpoint (random 100ms-2s sleep)
func handleSlow(w http.ResponseWriter, r *http.Request) {
	// Random sleep between 100ms and 2s
	sleepDuration := time.Duration(100+rand.Intn(1900)) * time.Millisecond
	time.Sleep(sleepDuration)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := map[string]string{
		"status":   "ok",
		"duration": sleepDuration.String(),
	}
	json.NewEncoder(w).Encode(resp)
}

// Handler: GET /error — returns 500 50% of the time
func handleError(w http.ResponseWriter, r *http.Request) {
	if rand.Float64() < 0.5 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		resp := map[string]string{
			"status": "error",
			"error":  "internal server error (simulated)",
		}
		json.NewEncoder(w).Encode(resp)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := map[string]string{
		"status": "ok",
	}
	json.NewEncoder(w).Encode(resp)
}

// loadGenerator hits the app's own endpoints every 5s to generate metrics data consistently
func loadGenerator(ctx context.Context, port string) {
	client := &http.Client{Timeout: 10 * time.Second}
	baseURL := fmt.Sprintf("http://localhost:%s", port)

	// Wait for server to start
	time.Sleep(2 * time.Second)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	endpoints := []string{"/", "/health", "/slow", "/error"}

	for {
		select {
		case <-ctx.Done():
			log.Println("Load generator shutting down...")
			return
		case <-ticker.C:
			// Hit each endpoint once per tick
			for _, endpoint := range endpoints {
				go func(ep string) {
					resp, err := client.Get(baseURL + ep)
					if err != nil {
						log.Printf("Load generator: error hitting %s: %v", ep, err)
						return
					}
					resp.Body.Close()
				}(endpoint)
			}
		}
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Create a new ServeMux
	mux := http.NewServeMux()

	// Register handlers
	mux.HandleFunc("/", handleRoot)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/slow", handleSlow)
	mux.HandleFunc("/error", handleError)
	mux.Handle("/metrics", promhttp.Handler())

	// Wrap with metrics middleware (skip /metrics to avoid recursion)
	handler := metricsMiddleware(mux)

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Context for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start load generator goroutine
	go loadGenerator(ctx, port)

	// Graceful shutdown on SIGTERM
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		sig := <-sigChan
		log.Printf("Received signal %v, shutting down gracefully...", sig)
		cancel()

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutdownCancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Fatalf("Server shutdown error: %v", err)
		}
	}()

	log.Printf("Starting prom-go-app on port %s", port)
	log.Printf("Metrics available at http://localhost:%s/metrics", port)

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("Server stopped gracefully")
}
