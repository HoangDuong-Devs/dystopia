# Output OCR và schema chuẩn hóa của Dystopia

Tài liệu này mô tả output thật của OCR (OpenCodeReview) và cách Dystopia chuẩn hóa nó
thành `{ meta, findings }`. Mẫu dưới đây lấy từ một lần chạy thật trên một commit core,
đã che nội dung.

## 1. Cấu trúc output OCR

Top-level:

| Trường | Ý nghĩa |
|---|---|
| `status` | trạng thái lần chạy |
| `llm.model` | model đã dùng, ví dụ `fake/model-1` |
| `message` | thông điệp của OCR |
| `summary` | `files_reviewed`, `comments`, `total_tokens`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `elapsed` (dạng `"15m49s"`) |
| `tool_calls` | số lần gọi công cụ |
| `comments` | mảng phát hiện, **có thể là `null`** khi review bị hủy |
| `groups` | nhóm phát hiện |
| `session_id` | id session, lưu ở `~/.opencodereview/sessions/` |
| `manifest` | `manifest.input.resolved_base`, `manifest.input.resolved_head`, ... |
| `retry_report` | báo cáo retry |

Mỗi phần tử `comments[]`:

| Trường | Ghi chú |
|---|---|
| `path` | file được review |
| `start_line`, `end_line` | số dòng, xem mục 2 |
| `severity` | `high` \| `medium` \| `low` |
| `category` | loại vấn đề |
| `content` | mô tả, thường nhiều câu |
| `existing_code` | đoạn code hiện tại |
| `suggestion_code` | có thể vắng |

OCR **không** có trường `confidence` và **không** có phán quyết kiểu
`verdict`/`approve`/`reject`: Dystopia chỉ tạo findings, việc duyệt thuộc về người review.

## 2. Phía dòng: start_line/end_line là phía HEAD

Kết luận: `start_line`/`end_line` đã là số dòng theo phía HEAD, không cần chuyển đổi.
Cách kiểm tay trên output thật của một commit core:

1. Lấy `manifest.input.resolved_head` và `resolved_base`.
2. Với từng comment, đối chiếu `existing_code` với file phía head (`git show <head>:<path>`):
   khớp đúng vị trí `start_line`–`end_line`.
3. Đối chiếu với file phía base (`git show <base>:<path>`): đoạn được trích chỉ tồn tại ở
   bản head, không có ở base — tức dòng đang trỏ về phía head.

Trong `lib/normalize.mjs`, mọi comment đi qua hàm `toHeadLine()` để chốt phía dòng
(kèm chú thích nguồn kết luận). Hàm giữ nguyên số dòng, chỉ điền `end_line`/`line` khi thiếu.

## 3. Map severity

| OCR | Dystopia |
|---|---|
| `high` | `chặn` |
| `medium` | `nên sửa` |
| `low` | `gợi ý` |
| khác / thiếu | `gợi ý` + cảnh báo ra stderr |

## 4. Schema chuẩn hóa `{ meta, findings }`

```json
{
  "meta": {
    "tool": "dystopia",
    "version": "v1",
    "base": "aaaa1111",
    "head": "bbbb2222",
    "model": "fake/model-1",
    "tokens_in": 12000,
    "tokens_out": 3234,
    "duration_ms": 949000
  },
  "findings": [
    {
      "severity": "chặn",
      "file": "src/file1.ts",
      "line": 40,
      "end_line": 41,
      "rule": "security",
      "claim": "Chuỗi truy vấn được ghép trực tiếp từ input người dùng",
      "evidence": "db.query('select * from t where id=' + id)",
      "confidence": null
    }
  ]
}
```

- `meta.base`/`meta.head`: ưu tiên `manifest.input.resolved_base`/`resolved_head`, rồi mới
  tới tham số CLI.
- `meta.version`: lấy từ biến môi trường `DYSTOPIA_VERSION` (CLI truyền vào), không có thì `null`.
- `meta.model`: `llm.model`; `tokens_in`/`tokens_out`: `summary.input_tokens`/`output_tokens`
  (null nếu thiếu).
- `meta.duration_ms`: tham số đo được, hoặc parse `summary.elapsed` (`"15m49s"`, `"9.5s"`,
  `"1h2m3s"`); không parse được thì `null`.
- `findings[]`: `file` ← `path`, `line` ← `start_line`, `end_line` ← `end_line`,
  `rule` ← `category`, `claim` ← câu đầu của `content` (cắt ở dấu chấm hoặc xuống dòng đầu
  tiên), `evidence` ← `existing_code` (null nếu không có), `confidence` ← null khi OCR không có.
- `comments` null/thiếu → `findings: []`.
- Sắp xếp ổn định: severity (`chặn` → `nên sửa` → `gợi ý`), rồi `confidence` giảm dần,
  `confidence` null xếp sau số; hoà thì giữ thứ tự gốc của OCR.

## 5. Dùng CLI chuẩn hóa

```
node lib/normalize.mjs r.json                  # JSON {meta, findings}
node lib/normalize.mjs r.json --text           # dạng text
node lib/normalize.mjs r.json --base X --head Y --duration-ms N
```

Dạng text: `[mức] file:line-end_line rule — claim`, mỗi finding một dòng.

## 6. Wrapper `dystopia review`

- Không tự truyền `--format`, không có `--raw`: wrapper chạy OCR với `--format json`,
  ghi output thô vào file tạm (`mktemp`), đo thời gian, chuẩn hóa rồi in JSON
  (hoặc ghi vào `--output F` nếu có; `--text` để in dạng text). File tạm được xóa khi xong.
- `--raw`: giữ hành vi cũ, trả nguyên output OCR.
- Tự truyền `--format`: tôn trọng format của người gọi, không chuẩn hóa.
- Exit code của OCR được giữ nguyên. Có thể thay binary OCR bằng `DYSTOPIA_OCR_BIN`.
