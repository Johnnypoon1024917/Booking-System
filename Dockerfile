# syntax=docker/dockerfile:1.6
#
# Multi-stage build for the FSD MRBS Platform.
#
#   stage 1 (node)  → compile the Vue 3 SPA
#   stage 2 (go)    → compile api, worker, scheduler, migrate binaries
#   stage 3 (alpine) → tiny runtime image containing all of the above
#
# The same final image runs as api / worker / scheduler — the
# docker-compose `command:` field selects which binary to launch.

# ---------- 1. SPA build ----------------------------------------------------
FROM node:20-alpine AS spa
WORKDIR /spa

# Faster + quieter npm. The cache mount persists ~/.npm across builds so
# rebuilds reuse already-downloaded tarballs instead of re-fetching.
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_PROGRESS=false

COPY src/presentation/web/spa/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefer-offline --no-audit --no-fund

COPY src/presentation/web/spa/ ./
RUN npm run build

# ---------- 2. Go build -----------------------------------------------------
FROM golang:1.26-alpine AS gobuild
RUN apk add --no-cache git
WORKDIR /src

# Cache modules first so source-only changes don't re-download them.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ENV CGO_ENABLED=0 GOOS=linux
RUN go build -trimpath -ldflags='-s -w' -o /out/api            ./src/cmd/api && \
    go build -trimpath -ldflags='-s -w' -o /out/worker         ./src/cmd/worker && \
    go build -trimpath -ldflags='-s -w' -o /out/webhook_worker ./src/cmd/webhook_worker && \
    go build -trimpath -ldflags='-s -w' -o /out/graph_worker   ./src/cmd/graph_worker && \
    go build -trimpath -ldflags='-s -w' -o /out/scheduler      ./src/cmd/scheduler && \
    go build -trimpath -ldflags='-s -w' -o /out/migrate        ./src/cmd/migrate

# ---------- 3. Runtime image ------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S app && adduser -S app -G app
ENV TZ=Asia/Hong_Kong
WORKDIR /app

# Binaries
COPY --from=gobuild /out/api            /app/api
COPY --from=gobuild /out/worker         /app/worker
COPY --from=gobuild /out/webhook_worker /app/webhook_worker
COPY --from=gobuild /out/graph_worker   /app/graph_worker
COPY --from=gobuild /out/scheduler      /app/scheduler
COPY --from=gobuild /out/migrate        /app/migrate

# Static assets — paths match the api binary's defaults
COPY --from=spa /spa/dist                          /app/src/presentation/web/spa/dist
COPY src/presentation/web/public                   /app/src/presentation/web/public
COPY src/infrastructure/postgres/migrations        /app/migrations

USER app
EXPOSE 8080
ENV LISTEN_ADDR=:8080 \
    SPA_DIR=/app/src/presentation/web/spa/dist

CMD ["/app/api"]
