# Crosstalk hub. No npm dependencies, so the image is just Node + the source.
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4545 \
    CROSSTALK_DB=/data/crosstalk.db

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node web ./web
COPY --chown=node:node lib ./lib
COPY --chown=node:node bridge ./bridge
COPY --chown=node:node mcp ./mcp
COPY --chown=node:node cli ./cli
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 4545
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4545/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
