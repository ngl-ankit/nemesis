"""Gunicorn configuration for Render.

SSE streaming needs workers that don't block on a long-lived response, so we
use gthread workers with a generous thread count and a long-ish timeout.
"""
import multiprocessing
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '10000')}"
workers = int(os.environ.get("WEB_CONCURRENCY", max(2, min(4, multiprocessing.cpu_count()))))
worker_class = "gthread"
threads = int(os.environ.get("GUNICORN_THREADS", "8"))
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "90"))
graceful_timeout = 30
keepalive = 5
accesslog = None  # structured request logs are emitted by the app itself
errorlog = "-"
loglevel = os.environ.get("LOG_LEVEL", "info").lower()
forwarded_allow_ips = "*"  # Render terminates TLS in front of us
