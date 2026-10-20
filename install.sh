#!/usr/bin/env bash
# Build OpenCodeReview vào bin/ và tự kiểm. Không sudo, không sửa clone upstream.
set -uo pipefail
DYSTOPIA_HOME="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SRC="${OCR_SRC:-$HOME/firemoth/tools/opencodereview}"
fail=0
ok(){ echo "OK   $*"; }; warn(){ echo "WARN $*"; }; bad(){ echo "FAIL $*"; fail=1; }
GO=""
for g in "${GO_BIN:-}" /usr/local/go/bin/go "$(command -v go 2>/dev/null)"; do
  [ -n "$g" ] && [ -x "$g" ] && { GO="$g"; break; }; done
if [ -z "$GO" ]; then
  warn "không thấy go. Cài Go >= 1.21 (https://go.dev/dl) hoặc đặt GO_BIN, rồi chạy lại."; echo "Kết quả: chưa sẵn sàng."; exit 1
fi
ok "go: $GO ($("$GO" version 2>/dev/null | awk '{print $3}'))"
[ -f "$SRC/go.mod" ] || { bad "không thấy mã nguồn ở $SRC"; echo "Kết quả: chưa sẵn sàng."; exit 1; }
COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
OCR_REF="${OCR_REF:-9867a3d}"
FULL="$(git -C "$SRC" rev-parse HEAD 2>/dev/null)"
case "$FULL" in "$OCR_REF"*) ok "nguồn: $SRC @ $COMMIT (đúng ref ghim $OCR_REF)";;
  *) bad "nguồn ở $COMMIT, khác ref ghim $OCR_REF. Không tự checkout; đặt OCR_REF hoặc đưa clone về đúng ref.";; esac
mkdir -p "$DYSTOPIA_HOME/bin"
if (cd "$SRC" && GOFLAGS=-buildvcs=false CGO_ENABLED=0 "$GO" build \
    -ldflags "-X main.Version=v0.0.0-$COMMIT -X main.GitCommit=$COMMIT -X main.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o "$DYSTOPIA_HOME/bin/opencodereview" ./cmd/opencodereview); then ok "build: bin/opencodereview"
else bad "build lỗi"; fi
if [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then warn "clone upstream có thay đổi chưa commit"; else ok "clone upstream sạch"; fi
if [ ! -f "$DYSTOPIA_HOME/.env" ]; then
  cp "$DYSTOPIA_HOME/.env.example" "$DYSTOPIA_HOME/.env"
  chmod 600 "$DYSTOPIA_HOME/.env"
  warn ".env tạo mới từ .env.example (quyền 600); Neid phải tự điền COMMANDCODE_API_KEY"
else
  perms="$(stat -c %a "$DYSTOPIA_HOME/.env" 2>/dev/null || true)"
  last3="${perms: -3}"
  if [ "${#last3}" -ge 3 ] && { [ "${last3: -2:1}" != "0" ] || [ "${last3: -1:1}" != "0" ]; }; then
    warn ".env có quyền $perms, rộng hơn 600; đã chmod 600 (không in nội dung)"
  else ok ".env đã có"; fi
fi
[ -f "$DYSTOPIA_HOME/rules-overlay/rule.json" ] && ok "rules-overlay/rule.json sẽ được truyền qua --rule" || ok "rules-overlay trống, dùng luật upstream"
chmod 600 "$DYSTOPIA_HOME/.env"; chmod 755 "$DYSTOPIA_HOME/dystopia" "$DYSTOPIA_HOME/install.sh"
if grep -q '^COMMANDCODE_API_KEY=.' "$DYSTOPIA_HOME/.env" || grep -q '^OCR_LLM_TOKEN=.' "$DYSTOPIA_HOME/.env"; then
  ok "key có trong .env (không in)"
else
  warn "chưa có key trong .env: Neid tự điền COMMANDCODE_API_KEY"
fi
if v="$("$DYSTOPIA_HOME/dystopia" --version 2>&1)"; then ok "dystopia --version: $(echo "$v" | head -1)"
elif "$DYSTOPIA_HOME/dystopia" --help >/dev/null 2>&1; then ok "dystopia --help chạy được"; else bad "dystopia không chạy được"; fi
[ $fail = 0 ] && echo "Kết quả: sẵn sàng." || { echo "Kết quả: chưa sẵn sàng."; exit 1; }
