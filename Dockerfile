# zelto — AI Programming Cockpit
# Multi-stage build for minimal production image

# ── Stage 1: Install dependencies ──────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# ── Stage 2: Build ─────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src/ src/
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build

# ── Stage 3: Runtime ───────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Install git for policy hooks and project scanning
RUN apk add --no-cache git

# Copy production deps and compiled output
COPY --from=deps /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY --from=build /app/package.json ./

# Copy default contracts/schemas
COPY contracts/schemas/ contracts/schemas/

# Entry point
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["--help"]
