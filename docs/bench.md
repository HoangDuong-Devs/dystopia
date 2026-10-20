# Bộ đo `dystopia bench`

`dystopia bench` chạy reviewer trên từng case (dải `base..head`), chấm finding theo danh sách
bug mong đợi, in bảng và ghi kết quả ra ngoài repo. Dữ liệu bench **không** nằm trong repo
Dystopia; repo chỉ chứa code chạy và fixture giả cho test.

## 1. Thư mục dữ liệu

| Biến | Mặc định |
|---|---|
| `DYSTOPIA_BENCH_DIR` | `$HOME/firemoth/tools/dystopia-bench` |

```
$DYSTOPIA_BENCH_DIR/
  cases/<id>.json          # cấu hình case, người dùng cung cấp
  results/<ngày>-<head>.json
```

- `<ngày>` là ngày địa phương dạng `YYYY-MM-DD`.
- `<head>` là git short HEAD của repo Dystopia, hoặc `nogit` nếu không lấy được.
- Nếu file kết quả đã tồn tại, thêm hậu tố `-2`, `-3`, ... Không bao giờ ghi đè.
- Bench chỉ đọc `cases/` và chỉ ghi vào `results/`.

## 2. Schema case

```json
{
  "id": "aeb2fc6",
  "repo": "<đường dẫn repo core>",
  "base": "aeb2fc6",
  "head": "0123abc",
  "expect_bugs": [
    { "id": "gioi-han-8000", "file": "src/file1.ts", "line_from": 120, "line_to": 126,
      "desc": "Thiếu giới hạn 8000 ký tự" },
    { "id": "thu-tu", "match": "file", "file": ["src/file2.ts", "src/file3.ts"],
      "line_from": null, "line_to": null, "desc": "Sai thứ tự kiểm tra" }
  ],
  "max_rank": 5,
  "forbid_severity": ["chặn"],
  "min_hit_rate": 1.0
}
```

| Trường | Bắt buộc | Mặc định | Ghi chú |
|---|---|---|---|
| `id` | có | – | chuỗi khác rỗng, dùng cho `--case` và bảng |
| `repo` | có | – | đường dẫn repo core |
| `base` | có | – | SHA hex 7–40 ký tự; **không** tự lấy commit cha |
| `head` | có | – | commit được checkout vào worktree detached |
| `expect_bugs` | có | – | mảng bug mong đợi |
| `max_rank` | không | `5` | chỉ xét finding có thứ hạng ≤ giá trị này |
| `forbid_severity` | không | `[]` | mọi finding thuộc các mức này làm case fail |
| `min_hit_rate` | không | `1.0` | ngưỡng tỉ lệ trúng của từng bug, trong khoảng 0–1 |
| `disabled` | không | `false` | `true` → bỏ qua case, hiện `skipped` |

Mỗi phần tử `expect_bugs`:

| Trường | `match: "lines"` | `match: "file"` |
|---|---|---|
| `id` | chuỗi, thiếu thì đặt `bug-<n>` | như bên trái |
| `file` | chuỗi file | chuỗi **hoặc** mảng chuỗi; chuỗi coi như mảng 1 phần tử |
| `line_from`, `line_to` | bắt buộc là số nguyên | phải là `null` hoặc vắng |
| `match` | `"lines"` (mặc định) | `"file"` |
| `desc` | không bắt buộc | không bắt buộc |

Trường lạ (`note`, `source`, `todo`, ...) bị bỏ qua. Case `disabled: true` được bỏ qua hoàn
toàn, không cần kiểm các trường còn lại; vẫn xuất hiện trong bảng với kết quả `skipped`.

## 3. Cách chạy một case

1. Tạo worktree detached: `git -C <repo> worktree add --detach /tmp/fm-fx-bench-<id>-<pid> <head>`.
2. Gọi engine qua hợp đồng chung (`docs/engine.md`) trong worktree: `review({ repo: worktree,
   base, head, limits })`, mặc định engine `ocr`; `--engine native` chạy engine native (xem
   `docs/native.md`) và chuyển tiếp các cờ giới hạn. Nếu đặt `DYSTOPIA_BENCH_REVIEWER`, bench chạy lệnh
   đó thay cho engine (cùng tham số `review --from <base> --to <head> --output <file tạm>`,
   ghi JSON đã chuẩn hóa vào `--output`); dùng cho test, không gọi LLM/OCR thật.
3. Đọc JSON `{ meta, findings }` do engine/reviewer trả về (schema ở `docs/ocr-output.md`).
4. Luôn `git worktree remove --force` trong `finally`, kể cả khi reviewer lỗi.

Reviewer lỗi (exit ≠ 0, output hỏng JSON, thiếu mảng `findings`) → lần chạy đó ghi `error`,
case fail, các case khác vẫn chạy tiếp.

## 4. Chấm điểm

Findings đã được `lib/normalize.mjs` sắp xếp sẵn; `rank` là chỉ số **1-based** trong mảng đó.
Số dòng finding là phía HEAD (normalize đã chốt).

- Bug `match: "lines"` trúng khi tồn tại finding:
  - `rank ≤ max_rank`,
  - cùng `file`,
  - khoảng `[line, end_line ?? line]` giao với `[line_from - 10, line_to + 10]`.
- Bug `match: "file"` trúng khi tồn tại finding có `rank ≤ max_rank` và `file` thuộc danh sách
  file chấp nhận; không xét số dòng.
- Finding cấm: mọi finding có `severity` trong `forbid_severity`, **mọi rank**.
- Finding "nên sửa" được đếm để theo dõi, không làm fail.

> **Giới hạn của `match: "file"`:** chỉ cần **một finding bất kỳ** đúng file trong top
> `max_rank` là tính trúng, nên rất dễ trúng nhầm (finding cùng file nhưng sai chỗ vẫn tính).
> Chỉ dùng khi bug không gắn với dòng code cụ thể; bug có dòng thì dùng `match: "lines"`.

Với `--runs N`, mỗi bug có `hit_rate = số lần trúng / N` (in ra làm tròn 2 chữ số, nên `2/3`
hiện là `0.67`). Bug **đạt** khi số lần trúng đủ ngưỡng, không so trực tiếp tỉ lệ đã làm tròn:

```
dung_sai  = min(0.01, min_hit_rate × runs / 2)
số_lần_cần = max(1, ceil(min_hit_rate × runs - dung_sai - 1e-9))   # min_hit_rate > 0
```

Trừ dung sai nhỏ để cấu hình `min_hit_rate` hai chữ số thập phân ứng với tỉ lệ in ra:
`0.67 × 3` → cần 2 lần trúng, còn `0.7 × 3` → cần 3 lần. Dung sai không vượt nửa ngưỡng,
nên `min_hit_rate` dương luôn cần ít nhất 1 lần trúng. `min_hit_rate: 1.0` với `--runs 1`
cần đúng lần chạy đó trúng. Case **pass** khi:

1. mọi bug có số lần trúng ≥ số lần cần ở trên, và
2. không lần chạy nào có finding cấm, và
3. không lần chạy nào lỗi.

Case không có `expect_bugs` vẫn pass nếu không có finding cấm và không lỗi.

## 5. Tham số dòng lệnh

```
dystopia bench [--runs N] [--case <id>]... [--engine <tên>]
               [--max-tool-calls N] [--max-tokens N] [--phase-split F] [--concurrency N]
```

| Tham số | Ý nghĩa |
|---|---|
| `--runs N` | số lần chạy mỗi case, số nguyên ≥ 1 (mặc định 1) |
| `--case <id>` | chỉ chạy case có id này; lặp lại được nhiều lần |
| `--engine <tên>` | engine review, mặc định `ocr`; engine `native` chạy pha file (commit B); tên lạ → exit 64 |
| `--max-tool-calls`, `--max-tokens`, `--phase-split`, `--concurrency` | giới hạn chuyển cho engine native; engine khác bỏ qua |

Tham số sai (ví dụ `--runs 0`, `--runs abc`) hoặc cấu hình case sai → in lỗi rõ ràng và exit 64,
trước khi chạy bất kỳ case nào.

## 6. Bảng kết quả

```
engine: ocr
case | bug trúng/tổng | tỉ lệ từng bug | finding cấm | nên sửa | tokens | thời gian | kết quả
```

- Dòng đầu `engine: <tên>`: engine đã dùng cho lần chạy (cùng giá trị ghi vào file kết quả).
- `bug trúng/tổng`: số bug đạt `min_hit_rate` / tổng số bug.
- `tỉ lệ từng bug`: dạng `id=0.67, id2=1`.
- `finding cấm`, `nên sửa`: cộng qua các lần chạy.
- `tokens`: `tokens_in + tokens_out` cộng qua các lần chạy; `null` nếu reviewer không báo.
- `thời gian`: tổng thời gian chạy reviewer (ms).
- `kết quả`: `pass`, `FAIL`, `skipped` hoặc `error`.

Exit code:

| Code | Ý nghĩa |
|---|---|
| `0` | mọi case không bị skip đều pass (kể cả khi tất cả đều skipped) |
| `1` | có case `FAIL` hoặc `error`, hoặc không ghi được file kết quả |
| `64` | cấu hình case hoặc tham số dòng lệnh sai |

## 7. File kết quả

Mỗi lần chạy ghi một JSON vào `results/`:

```json
{
  "started_at": "2026-01-01T00:00:00.000Z",
  "engine": "ocr",
  "dystopia_head": "1be201e",
  "runs": 3,
  "cases": [
    {
      "id": "aeb2fc6",
      "status": "pass",
      "config": { "id": "aeb2fc6", "base": "...", "head": "...", "expect_bugs": [], "max_rank": 5,
                  "forbid_severity": [], "min_hit_rate": 1, "disabled": false },
      "bugs": [{ "id": "gioi-han-8000", "hits": 3, "hit_rate": 1, "met": true }],
      "forbidden": 0,
      "medium": 2,
      "tokens": 15234,
      "duration_ms": 1200,
      "runs": [
        {
          "findings": [{ "file": "src/file1.ts", "line": 120, "severity": "chặn", "rank": 1 }],
          "bugs": [{ "id": "gioi-han-8000", "hit": true }],
          "tokens": { "in": 12000, "out": 3234 },
          "duration_ms": 400,
          "error": null
        }
      ]
    }
  ]
}
```

`config` là cấu hình đã chuẩn hóa (điền mặc định). `findings` trong từng lần chạy được rút gọn
còn `file`, `line`, `severity`, `rank`. Case `skipped` có `runs: []`. `engine` ở cấp tài liệu
là engine đã chạy (`ocr` hoặc tên engine truyền qua `--engine`).
