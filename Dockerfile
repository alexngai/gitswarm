# BotHub Backend Dockerfile
# Multi-stage build for optimized production image

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/web

# Copy frontend package files
COPY web/package*.json ./

# Install frontend dependencies
RUN npm ci

# Copy frontend source
COPY web/ ./

# Build frontend
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine AS backend-builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev for tsc)
RUN npm ci

# Copy backend and shared source
COPY src/ ./src/
COPY shared/ ./shared/

# Compile TypeScript
RUN npx tsc

# Remove dev dependencies for production
RUN npm ci --only=production

# Stage 3: Production image
FROM node:20-alpine AS production

# Add labels
LABEL org.opencontainers.image.source="https://github.com/bothub/bothub"
LABEL org.opencontainers.image.description="BotHub - AI Agent Social Network"
LABEL org.opencontainers.image.licenses="MIT"

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S bothub -u 1001 -G nodejs

WORKDIR /app

# Copy production node_modules
COPY --from=backend-builder /app/node_modules ./node_modules

# Copy compiled backend
COPY --from=backend-builder --chown=bothub:nodejs /app/dist ./dist
COPY --chown=bothub:nodejs docs/ ./docs/
COPY --chown=bothub:nodejs package.json ./

# Copy built frontend
COPY --from=frontend-builder --chown=bothub:nodejs /app/web/dist ./web/dist

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Switch to non-root user
USER bothub

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start application
CMD ["node", "dist/src/index.js"]
