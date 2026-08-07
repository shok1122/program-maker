# 管理者パスワードのハッシュ値を作る。出力の1行を .env に貼り付ける。
.PHONY: password
password:
	@tty=""; if [ -t 0 ] && [ -t 1 ]; then tty="-t"; fi; \
	docker run --rm -i $$tty -v "$(CURDIR)/server:/app/server:ro" \
	  node:22-alpine node /app/server/hash-password.js

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
	CADDYFILE=./Caddyfile docker compose --profile https up -d

# オレオレ証明書（自己署名証明書）で HTTPS を有効にして起動する。
# 公開できるドメイン名が無い場合や、80番が塞がれていて Let's Encrypt が使えない場合はこちら。
# 証明書は Caddy が自前の CA で発行し、期限が来る前に自動で作り直す。
# ブラウザで使うホスト名 / IP アドレスを .env の SITE_ADDRESS に（複数ならカンマ区切りで）書く。
.PHONY: up-https-selfsigned
up-https-selfsigned:
	@site="$$SITE_ADDRESS"; \
	[ -n "$$site" ] || site=$$(sed -n 's/^SITE_ADDRESS=\(..*\)/\1/p' .env 2>/dev/null | tail -1); \
	if [ -z "$$site" ]; then \
	  site=localhost; \
	  echo "SITE_ADDRESS が空なので localhost の証明書だけを作ります。"; \
	  echo "他の端末から見る場合は .env の SITE_ADDRESS にホスト名か IP アドレスを書いてください。"; \
	fi; \
	sni="$$DEFAULT_SNI"; \
	[ -n "$$sni" ] || sni=$$(sed -n 's/^DEFAULT_SNI=\(..*\)/\1/p' .env 2>/dev/null | tail -1); \
	[ -n "$$sni" ] || sni=$$(printf '%s' "$$site" | cut -d, -f1 | tr -d '[:space:]'); \
	case ",$$(printf '%s' "$$site" | tr -d '[:space:]')," in \
	  *",$$sni,"*) ;; \
	  *) echo "注意: DEFAULT_SNI=$$sni は SITE_ADDRESS に入っていません。この証明書は作られないので、"; \
	     echo "      IP アドレスで繋ぐと接続できません。DEFAULT_SNI を消すか SITE_ADDRESS に足してください。";; \
	esac; \
	echo "公開先: $$site（IP アドレスで繋いだときは $$sni の証明書を返します）"; \
	CADDYFILE=./Caddyfile.selfsigned SITE_ADDRESS="$$site" DEFAULT_SNI="$$sni" \
	  docker compose --profile https up -d

# オレオレ証明書を発行した CA の証明書を ./ca.crt に書き出す。
# 見る側の端末で「信頼されたルート証明機関」に入れると、証明書の警告が出なくなる。
.PHONY: ca-cert
ca-cert:
	@docker cp program-maker-caddy:/data/caddy/pki/authorities/local/root.crt ./ca.crt \
	  || { echo "CA の証明書が見つかりません。make up-https-selfsigned で起動してから実行してください。"; exit 1; }
	@echo "./ca.crt に書き出しました。見る側の端末に入れると証明書の警告が出なくなります。"

# 証明書の取得状況を追う。取れていれば certificate obtained successfully が出る。
.PHONY: logs-https
logs-https:
	docker compose --profile https logs -f caddy

.PHONY: down
down:
	docker compose --profile https down

.PHONY: restart
restart:
	docker compose restart

.PHONY: clean
clean:
	docker volume rm program-maker_program-data
