# Dystopia – công cụ review code của FireMoth (xây trên OpenCodeReview)

Công cụ review code bằng LLM (alibaba/open-code-review), đóng gói kiểu MTH: một lệnh `dystopia`, `install.sh` tự kiểm, key trong `.env`.

- **Ref ghim:** `9867a3d` (alibaba/open-code-review). Clone upstream ở `~/firemoth/tools/opencodereview`, coi là **chỉ đọc**. `install.sh` báo FAIL nếu clone lệch ref (đổi bằng `OCR_REF=...`).
- **Cài / kiểm:** `~/firemoth/tools/dystopia/install.sh` → in dòng OK/WARN/FAIL, cuối cùng `Kết quả: sẵn sàng.`
- **Model mặc định:** `deepseek/deepseek-v4.1-flash-fast` qua CommandCode (OpenAI-compatible).

## Gọi
```
DYSTOPIA=~/firemoth/tools/dystopia/dystopia
$DYSTOPIA review --output r.json                 # thay đổi chưa commit trong repo hiện tại
$DYSTOPIA review --from main --to feat/x --output r.json   # dải nhánh (merge-base)
$DYSTOPIA review -c abc123 --output r.json      # một commit
$DYSTOPIA review -c abc123 -p                    # xem trước file sẽ review
$DYSTOPIA review --format text                   # tự chọn format thì wrapper không ép JSON
```
`review` mặc định `--format json`. Chạy trong thư mục repo cần review.

## Biến môi trường (`.env`, hoặc file khác qua `DYSTOPIA_ENV_FILE`)
| Biến | Ý nghĩa |
|---|---|
| `COMMANDCODE_API_KEY` | key, được map sang `OCR_LLM_TOKEN` |
| `OCR_LLM_MODEL` | đổi model (mặc định trên) |
| `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `OCR_LLM_TOKEN` | ghi đè provider |
Không in key ra log/chat.

## Đầu ra JSON
`status`, `message`, `summary` (files_reviewed, comments, tokens, elapsed), `comments[]` gồm `path`, `start_line`, `end_line`, `severity` (high/medium/low), `category`, `content`, `existing_code`, `suggestion_code`; thêm `session_id`, `manifest`. Session lưu ở `~/.opencodereview/sessions/`.

## Luật review & rules-overlay
OCR tra luật theo chuỗi 4 lớp, lớp đầu khớp sẽ thắng: `--rule <file>` → `<repo>/.opencodereview/rule.json` → `~/.opencodereview/rule.json` → luật hệ thống nhúng trong binary (`merge_system_rule: true` để gộp với lớp hệ thống).
FireMoth không sửa luật upstream. Luật riêng đặt ở `~/firemoth/tools/dystopia/rules-overlay/rule.json` (hiện trống): nếu file tồn tại và người gọi không tự truyền `--rule`, wrapper tự thêm `--rule` cho `review`/`scan`. Lưu ý: khi đó overlay che luật project của repo được review.
