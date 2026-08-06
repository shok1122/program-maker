# 管理者パスワードのハッシュ値を作る。出力の1行を .env に貼り付ける。
# Node.js が入っていなければコンテナで実行する（イメージのビルドは不要）。
.PHONY: password
password:
	@if command -v node >/dev/null 2>&1; then \
	  node server/hash-password.js; \
	else \
	  tty=""; if [ -t 0 ] && [ -t 1 ]; then tty="-t"; fi; \
	  docker run --rm -i $$tty -v "$(CURDIR)/server:/app/server:ro" \
	    node:22-alpine node /app/server/hash-password.js; \
	fi

.PHONY: build
build:
	docker compose build

.PHONY: up
up:
	docker compose up -d

# Let's Encrypt でサーバ証明書を取得して HTTPS で公開する（Caddy を一緒に起動する）。
# 80/443 が外から到達できること、SITE_ADDRESS の DNS がこのホストを向いていることが前提。
.PHONY: up-https
up-https:
	@for v in SITE_ADDRESS ACME_EMAIL; do \
	  eval "val=\$$$$v"; \
	  [ -n "$$val" ] || val=$$(sed -n "s/^$$v=\(..*\)/\1/p" .env 2>/dev/null | tail -1); \
	  [ -n "$$val" ] || { echo "$$v を .env に設定してください（HTTPS で公開するのに必要です）"; exit 1; }; \
	done
	docker compose --profile https up -d

# 証明書の取得状況を追う。取れていれば certificate obtained successfully が出る。
.PHONY: logs-https
logs-https:
	docker compose --profile https logs -f caddy

.PHONY: down
down:
	docker compose --profile https down

.PHONY: clean
clean:
	docker volume rm program-maker_program-data
