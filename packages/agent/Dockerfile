FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace root
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

# Copy workspace package manifests (needed for npm ci --workspaces)
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/agent/package.json ./packages/agent/package.json

# Install all dependencies (includes devDeps for building)
RUN npm ci --workspaces

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/agent/src ./packages/agent/src

# Build
RUN npm run build -w packages/shared && npm run build -w packages/agent

# --------- Production stage ---------
FROM node:22-alpine AS runtime

# Install claude CLI (required for code execution)
RUN npm install -g @anthropic-ai/claude-code

# Install git (required by simple-git for repo operations)
RUN apk add --no-cache git

WORKDIR /app

# Copy built artifacts and package manifests
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/agent/dist ./packages/agent/dist
COPY --from=builder /app/packages/agent/package.json ./packages/agent/package.json
COPY --from=builder /app/package.json ./package.json

# Install production dependencies only
RUN npm ci --omit=dev --workspaces

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "packages/agent/dist/index.js"]
