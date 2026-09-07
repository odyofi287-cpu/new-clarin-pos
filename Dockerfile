# Multi-stage build: build client, install server deps, copy client build into server

# Client build stage
FROM node:22-bookworm AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
COPY client/ ./
RUN npm ci --include=dev
RUN npm run build

# Server stage
FROM node:22-bookworm
WORKDIR /app
# Install server dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --only=production
# Copy server source
COPY server/ ./server/
# Copy client build into server/dist for static serving
COPY --from=client-builder /app/client/dist ./server/dist

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "index.js"]
