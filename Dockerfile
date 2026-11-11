# --- Build the React app -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build

# --- Runtime: the API, which also serves the built web app ---------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY --from=build /app/web/dist web/dist

USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/healthz" || exit 1
CMD ["node", "server/src/index.js"]
