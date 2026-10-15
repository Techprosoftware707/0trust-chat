# syntax=docker/dockerfile:1.7
# Lumen portal / ops / worker image. Build context: repository root.
ARG PYTHON_BASE_IMAGE=python:3.13-slim-trixie

FROM ${PYTHON_BASE_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /build
COPY services/portal/requirements.txt .
# Optional build-time CA (only for networks with TLS inspection; empty by default).
RUN --mount=type=secret,id=build_extra_ca \
    if [ -s /run/secrets/build_extra_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_extra_ca > /tmp/ca.pem; \
      export PIP_CERT=/tmp/ca.pem SSL_CERT_FILE=/tmp/ca.pem; \
    fi; \
    python -m venv /venv \
 && /venv/bin/pip install --require-hashes --no-deps -r requirements.txt \
 && rm -f /tmp/ca.pem
COPY services/portal /app
COPY design /app/design
COPY branding /app/branding
RUN cd /app \
 && LUMEN_SURFACE=worker LUMEN_ALLOW_ENV_SECRETS=1 DJANGO_SECRET_KEY=build-only POSTGRES_PASSWORD=build-only \
    LUMEN_DESIGN_DIR=/app/design STATIC_ROOT=/app/staticfiles \
    /venv/bin/python manage.py collectstatic --noinput -v0 \
 && rm -rf /app/tests /app/requirements*.in

FROM ${PYTHON_BASE_IMAGE}
LABEL org.opencontainers.image.title="lumen-portal" \
      org.opencontainers.image.description="Lumen website, customer portal, operator console and worker" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
RUN groupadd -g 10001 lumen && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin lumen \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /venv /venv
COPY --from=build --chown=0:0 /app /app
ENV PATH=/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=lumen.settings \
    LUMEN_DESIGN_DIR=/app/design \
    LUMEN_BRANDING_DIR=/app/branding \
    STATIC_ROOT=/app/staticfiles
WORKDIR /app
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["web"]
