# Hợp đồng engine review

Dystopia v0.3 tách phần review thành **engine** cắm được. CLI, `--text`, sắp xếp, bench và
`docs/ocr-output.md` chỉ biết output của hợp đồng; chúng không biết engine nào ở bên dưới.
Engine hiện có: `ocr` (adapter bọc OpenCodeReview, mặc định) và `native` (chạy lõi Pi, commit B
mới có pha file — xem `docs/native.md`).

## 1. Hợp đồng

```js
review({ repo, base, head, rules, limits }) -> Promise<{ findings, meta }>
```

| Trường | Ý nghĩa |
|---|---|
| `repo` | thư mục repo cần review; engine chạy với cwd này |
| `base`, `head` | dải revision cần review; `null`/không có → review thay đổi chưa commit |
| `rules` | mảng file rule do người gọi chọn; rỗng → engine tự quyết (depot `rules-overlay/`) |
| `limits` | giới hạn tài nguyên của engine (token, số tool call); engine OCR bỏ qua |

Kết quả:

```json
{
  "meta": {
    "tool": "dystopia",
    "version": "0.3.0-dev",
    "engine": "ocr",
    "base": "aaaa1111",
    "head": "bbbb2222",
    "model": "fake/model-1",
    "tokens_in": 12000,
    "tokens_out": 3234,
    "duration_ms": 1200
  },
  "findings": [
    {
      "severity": "nên sửa",
      "file": "src/file1.ts",
      "line": 12,
      "end_line": 14,
      "rule": "error-handling",
      "claim": "Lỗi bị nuốt trong khối catch",
      "evidence": "try { run(); } catch (e) {}",
      "confidence": null
    }
  ]
}
```

- `severity` chỉ nhận `chặn`, `nên sửa`, `gợi ý`.
- `line`/`end_line` là số dòng **phía head**, số nguyên ≥ 1 hoặc `null`.
- Không có key phán quyết (`verdict`, `approve`, `reject`, ...): Dystopia chỉ đưa ra finding.
- Findings phải đã sắp xếp sẵn (severity tăng dần, rồi confidence giảm dần) — bench dùng thứ tự
  này làm `rank`.
- `meta.version` lấy từ file `VERSION`, ghi đè bằng `DYSTOPIA_VERSION` khi cần test.
- `meta.engine` là tên engine đã chạy.

`lib/engine/index.mjs` xuất `validateResult(result)` (trả mảng lỗi, rỗng = hợp lệ) và
`assertValidResult(result)` (ném lỗi đầu tiên gộp lại). Cả hai kiểm đúng schema ở trên; CLI
`review` và `bench` đều gọi `assertValidResult` trước khi dùng output.

## 2. Registry

```js
import { getEngine, registerEngine, listEngines } from './lib/engine/index.mjs';

getEngine('ocr');        // adapter OCR
getEngine('native');     // adapter engine native (pha file, commit B)
getEngine('khong-co');   // lỗi ENGINE_UNKNOWN: engine lạ
```

| Mã lỗi | Exit code CLI | Khi nào |
|---|---|---|
| `ENGINE_UNKNOWN` | 64 | tên engine không có trong registry |
| `ENGINE_UNAVAILABLE` | 64 | tên đã hứa nhưng chưa làm xong (hiện không còn engine nào) |
| `ENGINE_BAD_ADAPTER` | 64 | đăng ký engine thiếu hàm `review()` |
| `ENGINE_BAD_RESULT` | 1 | output engine sai schema |
| `OCR_MISSING` | 127 | chưa build binary OCR (thông điệp như cũ) |
| `OCR_FAILED` | exit code của OCR | OCR thoát khác 0 |
| `OCR_NO_OUTPUT`, `OCR_BAD_JSON` | 1 | OCR không ghi output / output hỏng JSON |

Mặc định engine là `ocr`.

## 3. Thêm engine mới

1. Viết module trả về object có `review(options)` đúng hợp đồng (ví dụ
   `lib/engine/native/index.mjs`).
2. Đăng ký trong `lib/engine/index.mjs`:
   ```js
   registerEngine('ten-engine', { name: 'ten-engine', review });
   ```
3. Nếu engine cần trạng thái "chưa có" trong giao diện CLI, thêm vào `NOT_READY` trong
   `lib/engine/index.mjs` để thông điệp rõ ràng thay vì "engine lạ" (hiện trống).
4. Thêm test hợp đồng: gọi `review()` với engine giả/fixture, rồi `validateResult` phải rỗng.

Không engine nào được ghi file; engine chỉ đọc repo và gọi model (`native` chạy lệnh git đọc
qua sandbox của MTH).

## 4. Adapter `ocr`

`lib/engine/ocr.mjs` chuyển toàn bộ logic chạy OCR của wrapper bash cũ vào node:

1. Chạy binary `DYSTOPIA_OCR_BIN` (mặc định `bin/opencodereview`) với
   `review --format json --output <file tạm> [--rule <overlay>] [--from base --to head] <cờ khác>`.
2. cwd = `repo`; stdout của OCR chuyển sang stderr; exit code của OCR giữ nguyên.
3. Đọc JSON thô, chuyển qua `lib/normalize.mjs`, thêm `meta.engine: "ocr"`.

- Nếu người gọi không truyền `--rule` nào và `rules-overlay/rule.json` tồn tại, adapter tự thêm
  `--rule` như wrapper cũ. `DYSTOPIA_HOME` đổi gốc tìm overlay (dùng trong test).
- Cờ khác của OCR (`-c`, `-p`, `--rule`, ...) được chuyển tiếp nguyên văn khi không có đủ
  `--from` và `--to`. Chỉ cần base/head thì CLI tách ra và truyền qua hợp đồng.
- Đường `--raw` và đường người gọi tự chọn `--format` vẫn exec thẳng binary OCR, không chuẩn
  hóa (hành vi cũ); các cờ của wrapper (`--engine`, `--dir`) được bỏ trước khi chuyển xuống.

## 5. CLI liên quan

```
dystopia review [--from <base> --to <head>] [--dir <repo>] [--engine ocr|native]
                [--output <file>] [--text] [--raw] [cờ của OCR...]
dystopia review --engine native --from <base> --to <head>
                [--max-tool-calls N] [--max-tokens N] [--phase-split F] [--concurrency N]
dystopia bench [--case <id>] [--runs N] [--engine ocr|native]
                [--max-tool-calls N] [--max-tokens N] [--phase-split F] [--concurrency N]
dystopia models          # model native dùng được, lấy từ agent/models.json của Dystopia
dystopia --version       # dystopia <VERSION> (<git short HEAD|nogit>)
```

`--dir` mặc định là thư mục hiện tại. `bench` ghi `engine` vào file kết quả và in
`engine: <tên>` ở dòng đầu bảng; khi không có `DYSTOPIA_BENCH_REVIEWER`, bench gọi engine qua
hợp đồng (không qua wrapper bash) và chuyển tiếp các cờ giới hạn.

`--engine native` bắt buộc có `--from`/`--to`; thiếu hoặc dùng `-c` → exit 64 với gợi ý dùng
`--from/--to`. Các cờ giới hạn của native cũng được `bench` nhận.

## 6. Engine native (commit B) và phần còn lại (commit C)

Commit B đã có:

- adapter native chạy lõi Pi qua thư viện, đọc key/model từ cấu hình riêng của Dystopia
  (`$DYSTOPIA_HOME`, `agent/models.json`), `DYSTOPIA_MODEL` chọn theo tên, model mặc định khác
  `CODER_DEFAULT_MODEL`, ghi model thật vào `meta.model`; `CODER_HOME` chỉ còn để tìm
  `$CODER_HOME/lib/sandbox-exec.sh` (thiếu → exit 64);
- pha file: mỗi file thay đổi một lượt agent, chạy song song có giới hạn;
- tool chỉ đọc `read_file`, `list_changed_files`, `grep`, `git_show`; `report_finding` kiểm
  schema ngay; lệnh git chạy qua `sandbox-exec` của MTH;
- `--max-tool-calls`, `--max-tokens`, `--phase-split`, `--concurrency`, `meta.truncated`;
- `dystopia models`.

Commit C còn lại: pha tổng, khử trùng lặp, nạp prompt/rules thật của Kosma. Prompt hiện là
bản tạm `lib/engine/native/prompts/placeholder.md`. Chi tiết kiến trúc, tool và biến môi
trường ở `docs/native.md`.
