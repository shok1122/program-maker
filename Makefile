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

.PHONY: down
down:
	docker compose down

.PHONY: clean
clean:
	docker volume rm program-maker_program-data
