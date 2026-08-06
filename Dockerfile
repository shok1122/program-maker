# 参加登録 + タイムテーブル作成ツール
# npm の依存関係が無いので、ソースを置くだけでそのまま動く。
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

COPY server ./server
COPY assets ./assets
COPY index.html admin.html login.html ./

# データは名前付きボリュームに置く。非root（node）で書けるように所有者を移す。
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["node", "server/server.js"]
