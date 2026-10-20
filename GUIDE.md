# Dystopia – công cụ review code của FireMoth (xây trên OpenCodeReview)

Công cụ review code bằng LLM (alibaba/open-code-review), đóng gói kiểu MTH: một lệnh `dystopia`, `install.sh` tự kiểm, key trong `.env` riêng của Dystopia (quyền 600).

- **Ref ghim:** `9867a3d` (alibaba/open-code-review). Clone upstream ở `~/firemoth/tools/opencodereview`, coi là **chỉ đọc**. `install.sh` báo FAIL nếu clone lệch ref (đổi bằng `OCR_REF=...`).
- **Cài / kiểm:** `~/firemoth/tools/dystopia/install.sh` → in dòng OK/WARN/FAIL, cuối cùng `Kết quả: sẵn sàng.`
- **Model mặc định của OCR:** `deepseek/deepseek-v4.1-flash-fast` qua CommandCode (OpenAI-compatible); engine native dùng `agent/models.json` riêng.

## Gọi
```
DYSTOPIA=~/firemoth/tools/dystopia/dystopia
$DYSTOPIA review --output r.json                 # thay đổi chưa commit, findings đã chuẩn hóa
$DYSTOPIA review --from main --to feat/x --output r.json   # dải nhánh (merge-base)
$DYSTOPIA review -c abc123 --output r.json      # một commit
$DYSTOPIA review -c abc123 -p                    # xem trước file sẽ review
$DYSTOPIA review --text                          # findings dạng text ra stdout
$DYSTOPIA review --engine ocr --dir ../core      # chọn engine, chọn repo cần review
$DYSTOPIA review --engine native --from main --to feat/x   # engine native (pha file, commit B)
$DYSTOPIA review --engine native --from main --to feat/x --max-tokens 300000 --concurrency 2
$DYSTOPIA review --raw --output raw.json         # output gốc của OCR (hành vi cũ)
$DYSTOPIA review --format text                   # tự chọn format thì wrapper không chuẩn hóa
$DYSTOPIA bench                                   # chạy mọi case bench một lần
$DYSTOPIA bench --runs 3 --case aeb2fc6           # lặp 3 lần, chỉ chọn case aeb2fc6
$DYSTOPIA bench --engine ocr                      # engine dùng cho bench (mặc định ocr)
$DYSTOPIA models                                  # model native dùng được (từ agent/models.json của Dystopia)
$DYSTOPIA --version                               # dystopia <VERSION> (<git short HEAD|nogit>)
```
`review` mặc định chạy engine `ocr`: OCR với `--format json` vào file tạm, chuẩn hóa thành
`{ meta, findings }` rồi in ra (hoặc ghi vào `--output F`). `--text` in mỗi finding một dòng
`[mức] file:line-end_line rule — claim`. `--raw` trả nguyên JSON của OCR; tự truyền `--format`
cũng bỏ qua bước chuẩn hóa. `--engine ocr|native` chọn engine (mặc định `ocr`), `--dir <repo>`
chọn repo (mặc định thư mục hiện tại). Hợp đồng engine, registry và cách thêm engine ở
`docs/engine.md`. File tạm được xóa khi xong (adapter OCR trong `lib/engine/ocr.mjs`), exit code
của OCR giữ nguyên. Chạy trong thư mục repo cần review (hoặc dùng `--dir`).

Engine `native` (commit B, pha file) chạy lõi Pi trong tiến trình thay cho binary OCR:
- Bắt buộc `--from <base> --to <head>`; thiếu hoặc dùng `-c` → exit 64 với gợi ý `--from/--to`.
- Key và model là của riêng Dystopia: launcher đọc `${DYSTOPIA_ENV_FILE:-$DYSTOPIA_HOME/.env}`
  (từ chối exit 64 nếu quyền rộng hơn 600), agent dir là
  `${DYSTOPIA_AGENT_DIR:-$DYSTOPIA_HOME/agent}`. Không dùng `$CODER_HOME/agent` hay `.env` của MTH.
- Model đọc từ `agent/models.json` (provider `commandcode`; `apiKey` chỉ là tên biến
  `COMMANDCODE_API_KEY`). `DYSTOPIA_MODEL` chọn theo tên, mặc định là model khác model viết code
  (`CODER_DEFAULT_MODEL`, mặc định `deepseek-v4.1-flash-fast`). `dystopia models` in danh sách,
  đánh dấu `*` model Dystopia đang chọn và `[code]` model viết code.
- `CODER_HOME` vẫn bắt buộc nhưng **chỉ** để tìm `$CODER_HOME/lib/sandbox-exec.sh`; thiếu biến
  hoặc thiếu file → exit 64.
- Mỗi file thay đổi một lượt agent; tool chỉ đọc `read_file` (tối đa 400 dòng/lần),
  `list_changed_files`, `grep` (tối đa 200 dòng khớp), `git_show` (chỉ base/head), và
  `report_finding` kiểm schema ngay (severity, dòng phía head, evidence...).
- Giới hạn: `--max-tool-calls` (mặc định 40/file), `--max-tokens` (mặc định 400000),
  `--phase-split` (mặc định 0.7 cho pha file), `--concurrency` (mặc định 2). Chạm giới hạn thì
  dừng lượt, giữ finding đã có, ghi file vào `meta.truncated`.
- Lệnh git chạy qua `$CODER_HOME/lib/sandbox-exec.sh` (sandbox chỉ đọc của MTH), không tự
  viết sandbox.
- Prompt hiện là bản tạm `lib/engine/native/prompts/placeholder.md`; pha tổng, khử trùng lặp
  và prompt/rules thật của Kosma là commit C. Chi tiết ở `docs/native.md`.

Tên engine lạ vẫn exit 64. `--engine ocr` giữ nguyên hành vi cũ.

## Bộ đo (`bench`)
Case nằm ngoài repo, ở `$DYSTOPIA_BENCH_DIR/cases/*.json` (mặc định
`$HOME/firemoth/tools/dystopia-bench`). Mỗi lần chạy, bench tạo worktree detached trong
`/tmp`, gọi engine qua hợp đồng chung (mặc định `ocr`, không qua wrapper bash) để review
`--from <base> --to <head>`, chấm finding rồi xóa worktree. Kết quả được ghi vào
`$DYSTOPIA_BENCH_DIR/results/<ngày>-<head dystopia>.json` (thêm `-2`, `-3` nếu trùng; không ghi
đè) và có trường `engine`. Repo chỉ chứa code chạy và fixture giả cho test.

```
$DYSTOPIA bench                    # mỗi case 1 lần
$DYSTOPIA bench --runs 3           # mỗi case 3 lần, báo tỉ lệ trúng
$DYSTOPIA bench --case 728a435     # chỉ chạy case được chọn (lặp lại --case được)
$DYSTOPIA bench --engine ocr       # chọn engine (mặc định ocr)
$DYSTOPIA bench --engine native --max-tokens 300000 --concurrency 2
```

Bảng in ra có: dòng đầu `engine: <tên>`, rồi case, bug trúng/tổng, tỉ lệ từng bug, số finding
cấm, số finding "nên sửa", tokens, thời gian, kết quả (`pass`/`FAIL`/`skipped`/`error`). Exit 0
khi mọi case không bị skip đều pass, 1 khi có case fail, 64 khi cấu hình/tham số sai (kể cả
engine lạ). `--engine native` dùng được và nhận các cờ giới hạn. Schema case và cách chấm chi tiết ở `docs/bench.md`.

## Biến môi trường (`.env`, hoặc file khác qua `DYSTOPIA_ENV_FILE`)
| Biến | Ý nghĩa |
|---|---|
| `DYSTOPIA_HOME` | thư mục dữ liệu/cấu hình; mặc định thư mục cài (launcher export cho node con) |
| `DYSTOPIA_ENV_FILE` | env file; mặc định `$DYSTOPIA_HOME/.env` (quyền không rộng hơn 600) |
| `DYSTOPIA_AGENT_DIR` | agent dir riêng; mặc định `$DYSTOPIA_HOME/agent` |
| `COMMANDCODE_API_KEY` | key thật; native đọc trực tiếp, OCR được map sang `OCR_LLM_TOKEN` |
| `OCR_LLM_MODEL` | đổi model (mặc định trên) |
| `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `OCR_LLM_TOKEN` | ghi đè provider |
| `DYSTOPIA_BENCH_DIR` | thư mục dữ liệu bench (mặc định `$HOME/firemoth/tools/dystopia-bench`) |
| `DYSTOPIA_BENCH_REVIEWER` | lệnh reviewer thay cho `dystopia review` (dùng khi test) |
| `CODER_HOME` | thư mục cài MTH, chỉ để tìm `$CODER_HOME/lib/sandbox-exec.sh` (bắt buộc với engine native) |
| `DYSTOPIA_MODEL` | model native dùng; phải có trong `agent/models.json` của Dystopia |
| `DYSTOPIA_PI_SDK` | ghi đè đường dẫn `dist/index.js` của Pi SDK |
| `DYSTOPIA_NATIVE_DRIVER` | file `.mjs` driver giả, chỉ dùng khi test |

Không in key ra log/chat, không đưa key vào meta/output JSON.

**Xoay key:** trên fc1 phải cập nhật **cả hai** bản `.env` — `.env` của MTH và
`$DYSTOPIA_HOME/.env` của Dystopia. Tên biến: `COMMANDCODE_API_KEY`, `OCR_LLM_TOKEN`,
`OCR_LLM_MODEL`, `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `DYSTOPIA_MODEL`, `CODER_HOME`.

## Đầu ra JSON
Mặc định `review` in schema chuẩn hóa `{ meta, findings }`:
- `meta`: `tool` (`dystopia`), `version` (lấy từ file `VERSION`, mặc định `0.3.0-dev`), `engine`
  (tên engine đã chạy), `base`, `head`, `model`, `tokens_in`, `tokens_out`, `duration_ms` (đo khi
  chạy, hoặc parse `summary.elapsed`).
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
FireMoth không sửa luật upstream. Luật riêng đặt ở `~/firemoth/tools/dystopia/rules-overlay/rule.json` (hiện trống): nếu file tồn tại và người gọi không tự truyền `--rule`, adapter OCR tự thêm `--rule` cho `review`/`scan`. Lưu ý: khi đó overlay che luật project của repo được review.
