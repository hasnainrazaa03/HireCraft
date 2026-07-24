# syntax=docker/dockerfile:1

# --- Stage 1: fetch the Tectonic binary -------------------------------------
FROM debian:bookworm-slim AS tectonic

ARG TECTONIC_VERSION=0.16.9

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/tectonic

# Deliberately NOT using the official drop-sh installer. It picks a target from
# the host's libc, so on an arm64 glibc base it requests
# aarch64-unknown-linux-gnu - an asset Tectonic does not publish - and the build
# dies with a 404. That breaks every Apple Silicon and arm64 server build.
#
# Resolving the target explicitly and always taking the musl build avoids this:
# musl releases exist for both architectures and are statically linked, so the
# binary does not care what libc the runtime image ships.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) target='x86_64-unknown-linux-musl' ;; \
      arm64) target='aarch64-unknown-linux-musl' ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${target}.tar.gz"; \
    curl --proto '=https' --tlsv1.2 -fsSL "$url" -o tectonic.tar.gz; \
    tar -xzf tectonic.tar.gz; \
    rm tectonic.tar.gz; \
    chmod +x tectonic; \
    ./tectonic --version


# --- Stage 2: application ----------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Tectonic caches downloaded LaTeX support files here; mount a volume on it
    # so every container start does not re-fetch the bundle.
    TECTONIC_CACHE_DIR=/var/cache/tectonic

# The Tectonic binary copied in below is a static musl build, so it needs no
# font, ICU, or TLS shared libraries at runtime. Listing them here was not just
# redundant, it was actively fragile: python:3.12-slim tracks Debian, and when
# the base moved from bookworm to trixie the pinned libicu72 vanished and the
# image stopped building. ca-certificates is still needed for Tectonic's HTTPS
# bundle fetch, and curl for the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
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
