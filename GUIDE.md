# Dystopia – công cụ review code của FireMoth (xây trên OpenCodeReview)

Công cụ review code bằng LLM (alibaba/open-code-review), đóng gói kiểu MTH: một lệnh `dystopia`, `install.sh` tự kiểm, key trong `.env`.

- **Ref ghim:** `9867a3d` (alibaba/open-code-review). Clone upstream ở `~/firemoth/tools/opencodereview`, coi là **chỉ đọc**. `install.sh` báo FAIL nếu clone lệch ref (đổi bằng `OCR_REF=...`).
- **Cài / kiểm:** `~/firemoth/tools/dystopia/install.sh` → in dòng OK/WARN/FAIL, cuối cùng `Kết quả: sẵn sàng.`
- **Model mặc định:** `deepseek/deepseek-v4.1-flash-fast` qua CommandCode (OpenAI-compatible).

## Gọi
```
DYSTOPIA=~/firemoth/tools/dystopia/dystopia
$DYSTOPIA review --output r.json                 # thay đổi chưa commit, findings đã chuẩn hóa
$DYSTOPIA review --from main --to feat/x --output r.json   # dải nhánh (merge-base)
$DYSTOPIA review -c abc123 --output r.json      # một commit
$DYSTOPIA review -c abc123 -p                    # xem trước file sẽ review
$DYSTOPIA review --text                          # findings dạng text ra stdout
$DYSTOPIA review --raw --output raw.json         # output gốc của OCR (hành vi cũ)
$DYSTOPIA review --format text                   # tự chọn format thì wrapper không chuẩn hóa
$DYSTOPIA bench                                   # chạy mọi case bench một lần
$DYSTOPIA bench --runs 3 --case aeb2fc6           # lặp 3 lần, chỉ chọn case aeb2fc6
```
`review` mặc định chạy OCR với `--format json` vào file tạm (`mktemp`), đo thời gian, chuẩn hóa
thành `{ meta, findings }` rồi in ra (hoặc ghi vào `--output F`). `--text` in mỗi finding một
dòng `[mức] file:line-end_line rule — claim`. `--raw` trả nguyên JSON của OCR; tự truyền
`--format` cũng bỏ qua bước chuẩn hóa. File tạm được xóa khi xong, exit code của OCR giữ nguyên.
Chạy trong thư mục repo cần review.

## Bộ đo (`bench`)
Case nằm ngoài repo, ở `$DYSTOPIA_BENCH_DIR/cases/*.json` (mặc định
`$HOME/firemoth/tools/dystopia-bench`). Mỗi lần chạy, bench tạo worktree detached trong
`/tmp`, gọi reviewer với `--from <base> --to <head>`, chấm finding rồi xóa worktree. Kết quả
được ghi vào `$DYSTOPIA_BENCH_DIR/results/<ngày>-<head dystopia>.json` (thêm `-2`, `-3` nếu
trùng; không ghi đè). Repo chỉ chứa code chạy và fixture giả cho test.

```
$DYSTOPIA bench                    # mỗi case 1 lần
$DYSTOPIA bench --runs 3           # mỗi case 3 lần, báo tỉ lệ trúng
$DYSTOPIA bench --case 728a435     # chỉ chạy case được chọn (lặp lại --case được)
```

Bảng in ra có: case, bug trúng/tổng, tỉ lệ từng bug, số finding cấm, số finding "nên sửa",
tokens, thời gian, kết quả (`pass`/`FAIL`/`skipped`/`error`). Exit 0 khi mọi case không bị
skip đều pass, 1 khi có case fail, 64 khi cấu hình/tham số sai. Schema case và cách chấm chi
tiết ở `docs/bench.md`.

## Biến môi trường (`.env`, hoặc file khác qua `DYSTOPIA_ENV_FILE`)
| Biến | Ý nghĩa |
|---|---|
| `COMMANDCODE_API_KEY` | key, được map sang `OCR_LLM_TOKEN` |
| `OCR_LLM_MODEL` | đổi model (mặc định trên) |
| `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `OCR_LLM_TOKEN` | ghi đè provider |
| `DYSTOPIA_BENCH_DIR` | thư mục dữ liệu bench (mặc định `$HOME/firemoth/tools/dystopia-bench`) |
| `DYSTOPIA_BENCH_REVIEWER` | lệnh reviewer thay cho `dystopia review` (dùng khi test) |
Không in key ra log/chat.

## Đầu ra JSON
Mặc định `review` in schema chuẩn hóa `{ meta, findings }`:
- `meta`: `tool` (`dystopia`), `version`, `base`, `head`, `model`, `tokens_in`, `tokens_out`,
  `duration_ms` (đo khi chạy, hoặc parse `summary.elapsed`).
- `findings[]`: `severity` (`chặn`/`nên sửa`/`gợi ý`, map từ `high`/`medium`/`low`), `file`,
  `line`, `end_line`, `rule`, `claim` (câu đầu của `content`), `evidence` (từ `existing_code`),
  `confidence` (OCR không có nên hiện là `null`).

`start_line`/`end_line` của OCR đã là số dòng phía HEAD nên không chuyển đổi. `comments` null
(review bị hủy) → `findings: []`. Dùng `--text` để in dạng text, `--raw` để lấy output gốc của
OCR (`status`, `message`, `summary`, `comments[]` với `path`, `start_line`, `end_line`,
`severity` high/medium/low, `category`, `content`, `existing_code`, `suggestion_code`;
thêm `session_id`, `manifest`). Chi tiết: `docs/ocr-output.md`. Session lưu ở
`~/.opencodereview/sessions/`.

## Luật review & rules-overlay
OCR tra luật theo chuỗi 4 lớp, lớp đầu khớp sẽ thắng: `--rule <file>` → `<repo>/.opencodereview/rule.json` → `~/.opencodereview/rule.json` → luật hệ thống nhúng trong binary (`merge_system_rule: true` để gộp với lớp hệ thống).
FireMoth không sửa luật upstream. Luật riêng đặt ở `~/firemoth/tools/dystopia/rules-overlay/rule.json` (hiện trống): nếu file tồn tại và người gọi không tự truyền `--rule`, wrapper tự thêm `--rule` cho `review`/`scan`. Lưu ý: khi đó overlay che luật project của repo được review.
