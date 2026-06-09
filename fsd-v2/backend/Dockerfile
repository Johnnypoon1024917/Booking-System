# Multi-stage build: deps → build → runtime. Slim runtime image (no dev deps)
# keeps the production container small and minimizes attack surface (AUD-026).
#
# - npm ci with the copied lockfile makes builds reproducible (AUD-026).
# - The runtime stage installs ONLY production dependencies (npm ci --omit=dev)
#   so build tooling (typescript, nest-cli, etc.) is not shipped.
# - Runs as the non-root `node` user (AUD-029).
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production dependencies only — separate install so the runtime image never
# carries dev/build dependencies.
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3000
# Drop root (AUD-029): the stock node image ships an unprivileged `node` user.
USER node
CMD ["node", "dist/main.js"]
