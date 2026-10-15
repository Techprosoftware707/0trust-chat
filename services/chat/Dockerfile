# syntax=docker/dockerfile:1.7
# Lumen web chat client: static build only. Build context: repository root.
#
#   docker build -f services/chat/Dockerfile --target dist \
#     [--secret id=build_extra_ca,src=/path/to/extra-ca.pem] \
#     --output type=local,dest=/path/to/www/chat .
#
ARG NODE_BASE_IMAGE=node:24-trixie-slim

FROM ${NODE_BASE_IMAGE} AS build
ENV CI=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src/services/chat
COPY services/chat/package.json services/chat/package-lock.json ./
# Optional build-time CA (only for networks with TLS inspection; empty by default).
# No dependency needs an install script (only macOS-only fsevents has one), so none run.
RUN --mount=type=secret,id=build_extra_ca \
    --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/build_extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_extra_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund
# Shared design tokens/fonts and the default brand assets, at the same relative paths as in the repo.
COPY design /src/design
COPY branding /src/branding
COPY services/chat /src/services/chat
RUN npm run build \
 && test -f dist/index.html \
 && ls dist/assets/*.wasm >/dev/null \
 && ! ls dist/assets/*.map >/dev/null 2>&1

# Final stage: only the static files, at /.
FROM scratch AS dist
COPY --from=build /src/services/chat/dist/ /
