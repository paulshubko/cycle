FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY web ./web
ENV NODE_ENV=production PORT=8790 DATA_DIR=/data NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8790/api/health || exit 1
CMD ["node", "server.js"]
