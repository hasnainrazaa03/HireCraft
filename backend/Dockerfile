# syntax=docker/dockerfile:1

# --- Stage 1: fetch the Tectonic binary -------------------------------------
FROM debian:bookworm-slim AS tectonic

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/tectonic
# The official installer resolves the correct build for the target architecture.
RUN curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh \
    && chmod +x tectonic \
    && ./tectonic --version


# --- Stage 2: application ----------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Tectonic caches downloaded LaTeX support files here; mount a volume on it
    # so every container start does not re-fetch the bundle.
    TECTONIC_CACHE_DIR=/var/cache/tectonic

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libfontconfig1 \
      libfreetype6 \
      libgraphite2-3 \
      libharfbuzz0b \
      libicu72 \
      libssl3 \
      curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tectonic /opt/tectonic/tectonic /usr/local/bin/tectonic

WORKDIR /app

# Dependencies first so code edits do not invalidate the layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Templates live at the repo root; docker-compose mounts them at /app/templates.
RUN useradd --create-home --uid 10001 hirecraft \
    && mkdir -p /app/artifacts "$TECTONIC_CACHE_DIR" \
    && chown -R hirecraft:hirecraft /app "$TECTONIC_CACHE_DIR"

USER hirecraft

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
