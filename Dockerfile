FROM node:24-bookworm-slim AS node-runtime

FROM postgres:18-bookworm

COPY --from=node-runtime /usr/local/ /usr/local/

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates mariadb-client rclone sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=4173 \
    DATA_DIR=/state \
    BACKUP_DIR=/backups \
    BACKUP_SOURCE_ROOT=/sources

EXPOSE 4173
ENTRYPOINT ["node", "server.mjs"]
