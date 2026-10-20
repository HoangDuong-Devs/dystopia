# Engine native (v0.3 commit B)

Engine `native` chạy lõi Pi qua thư viện, thay vì gọi binary OCR. Commit B mới có
**pha file**: mỗi file thay đổi một lượt agent, tool chỉ đọc, `report_finding` kiểm schema
ngay, giới hạn tool call/token và `meta.truncated`. Pha tổng, khử trùng lặp và prompt/rules
thật là **commit C**.

```
dystopia review --engine native --from <base> --to <head> [--dir <repo>] \
  [--max-tool-calls N] [--max-tokens N] [--phase-split F] [--concurrency N]
dystopia models
```

## 1. Kiến trúc

| File | Việc |
|---|---|
| `lib/engine/native/index.mjs` | adapter cho hợp đồng `review({repo, base, head, rules, limits})`; nối tool, model, driver, vòng lặp; gọi `validateResult` trước khi trả |
| `lib/engine/native/coder.mjs` | tìm MTH qua `CODER_HOME`, parse `$CODER_HOME/coder models`, chọn model; CLI `dystopia models` |
| `lib/engine/native/tools.mjs` | 4 tool chỉ đọc + chạy git qua `sandbox-exec` của MTH + danh sách file bỏ qua |
| `lib/engine/native/finding.mjs` | `report_finding`, kiểm schema, sắp xếp finding |
| `lib/engine/native/loop.mjs` | pha file, pool song song có giới hạn, ngân sách token/tool call, meta |
| `lib/engine/native/driver-pi.mjs` | driver Pi SDK (`createAgentSession`, `noTools` + `customTools`) |
| `lib/engine/native/limits.mjs` | chuẩn hóa `--max-tool-calls`, `--max-tokens`, `--phase-split`, `--concurrency` |
| `lib/engine/native/prompts/placeholder.md` | prompt tạm, chờ Kosma viết prompt thật ở commit C |

`normalize`, `--text`, `bench` và CLI không biết engine nào bên dưới: tất cả đi qua hợp đồng
`{ findings, meta }` ở `docs/engine.md`.

## 2. Tìm MTH và chọn model

- `CODER_HOME` là **bắt buộc**, không có giá trị mặc định. Thiếu hoặc không có
  `$CODER_HOME/coder` → lỗi rõ, exit 64.
- `listModels()` chạy `$CODER_HOME/coder models` và parse bảng (dòng đầu là header
  `provider model context max-out thinking images`). Engine không tự đọc
  `auth.json`/`.env` của MTH; Pi đọc qua agent dir `$CODER_HOME/agent`.
- `DYSTOPIA_MODEL` đặt → phải có trong bảng, khớp theo tên model (kèm `provider/` nếu có);
  không có → exit 64 kèm danh sách.
- Không đặt `DYSTOPIA_MODEL` → model đầu tiên trong danh sách ưu tiên
  `deepseek/deepseek-v4.1-flash`, `Qwen/Qwen3.8-Omni-Flash` có trong bảng **và khác model
  viết code**; không có thì model đầu tiên khác model viết code; không còn ứng viên → exit 64.
- Model viết code là `CODER_DEFAULT_MODEL`, mặc định `deepseek-v4.1-flash-fast`.
  So sánh "khác" theo tên model sau khi bỏ tiền tố provider/vendor, nên
  `deepseek-v4.1-flash-fast` khác `deepseek-v4.1-flash`.
- `meta.model` là model **thật** driver báo (session của Pi), không phải nhãn đã chọn.
- `dystopia models` in bảng model MTH, đánh dấu `*` model Dystopia đang chọn và
  `[code]` model viết code.

## 3. Tool chỉ đọc

`repo` là worktree đang ở revision **head**. Chỉ có đúng 5 tool:

| Tool | Việc |
|---|---|
| `read_file(path, from, to)` | đọc tối đa **400 dòng/lần**; vượt thì cắt và báo trong kết quả |
| `list_changed_files()` | `git diff --name-status` + `--numstat` base..head, kèm `+/-`; bỏ file lock/sinh tự động/binary |
| `grep(pattern, path_glob)` | `git grep -n`, tối đa **200 dòng khớp**, có ghi chú khi cắt |
| `git_show(rev, path)` | chỉ nhận `rev` là base hoặc head |
| `report_finding(...)` | xem mục 4 |

Danh sách bỏ qua lấy từ `rules-overlay/ignore.txt` (nếu có) cộng mặc định:
`*.lock`, `package-lock.json`, `bun.lockb`, `dist/**`, `*.min.js`, và file binary nhận ra qua
numstat `-`. File đã xoá ở head không vào danh sách review (không thể báo finding theo dòng head).

Chặn đường dẫn cho mọi tool:

- từ chối đường dẫn tuyệt đối;
- từ chối mọi đoạn `..` (kể cả khi chuẩn hóa vẫn nằm trong repo);
- từ chối path có đoạn `.git`;
- `realpath` sau khi giải symlink phải nằm trong `realpath(repo)`; symlink trỏ ra ngoài bị từ chối;
- với glob của `grep`, các đoạn tĩnh trước ký tự glob cũng được kiểm symlink.

`read_file` đọc bằng `fs` trong tiến trình. Các lệnh git chạy qua
`$CODER_HOME/lib/sandbox-exec.sh '<lệnh git>'` với `CODER_WORKDIR=<repo>`: sandbox bwrap
chỉ đọc của MTH, không mạng. Engine không tự viết sandbox và không chạy lệnh nào khác ngoài
git đọc.

## 4. `report_finding`

```
report_finding(file, line, end_line, severity, rule, claim, evidence, confidence)
```

Kiểm **ngay khi agent gọi**, trả chuỗi lỗi để agent sửa trong cùng lượt; finding hỏng không
bao giờ vào output:

- `severity` ∈ `chặn` / `nên sửa` / `gợi ý`;
- `file` phải nằm trong danh sách file thay đổi được review;
- `line`, `end_line` là số nguyên, `1 ≤ line ≤ end_line ≤ số dòng file ở head`;
- `rule`, `claim`, `evidence` là chuỗi khác rỗng;
- `confidence` là số 0–1 (hoặc bỏ trống → `null`).

Finding hợp lệ được thêm vào danh sách, sắp xếp theo severity rồi confidence giảm dần (null
sau cùng), và cả kết quả đi qua `validateResult` của commit A.

## 5. Vòng lặp và giới hạn

1. Lấy file thay đổi (đã lọc), mỗi file lấy diff `base..head` của riêng file đó.
2. Mỗi file một lượt agent, chạy song song tối đa `--concurrency` (mặc định **2**).
3. Ngân sách token tổng chia theo pha: `--phase-split` (mặc định **0.7**) cho pha file,
   phần còn lại để dành cho pha tổng ở commit C. Ngân sách pha file chia đều cho các file.
4. Chạm `--max-tool-calls` (mặc định **40/file**) hoặc ngân sách token của file → dừng lượt đó
   (`abort`), giữ finding đã có, thêm file vào `meta.truncated`.
5. Không có tool ghi file/chạy lệnh cho agent.

`meta` của engine native:

```json
{
  "tool": "dystopia",
  "version": "0.3.0-dev",
  "engine": "native",
  "base": "aaaa1111",
  "head": "bbbb2222",
  "model": "provider/model-that-ran",
  "tokens_in": 1200,
  "tokens_out": 300,
  "duration_ms": 1500,
  "tool_calls": 4,
  "truncated": ["src/file1.ts"],
  "concurrency": 2,
  "limits": { "max_tool_calls": 40, "max_tokens": 400000, "phase_split": 0.7 },
  "phases": {
    "file": {
      "tokens_in": 1200,
      "tokens_out": 300,
      "tool_calls": 4,
      "duration_ms": 1200,
      "files": [
        { "file": "src/file1.ts", "tokens_in": 1200, "tokens_out": 300,
          "tool_calls": 4, "truncated": true }
      ]
    }
  }
}
```

## 6. Driver Pi

`driver-pi.mjs` tách lớp `createDriver`/`prompt`/`usage`/`abort` khỏi vòng lặp:

- import động Pi SDK: `DYSTOPIA_PI_SDK` nếu đặt, mặc định
  `$CODER_HOME/../pi/packages/coding-agent/dist/index.js`;
- đặt `PI_CODING_AGENT_DIR=$CODER_HOME/agent` để Pi đọc auth/models của MTH;
- `SessionManager.inMemory()`, settings trong bộ nhớ (tắt compaction/retry);
- `noTools: true` + `customTools` đúng 5 tool ở trên;
- model lấy từ `coder.mjs`, thinking `off`, system prompt là `prompts/placeholder.md`.

Test không gọi LLM thật: truyền driver giả qua tham số `driver` của adapter hoặc đặt
`DYSTOPIA_NATIVE_DRIVER=<file .mjs>` (file export `createDriver(options)`).

## 7. Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `CODER_HOME` | thư mục cài MTH (bắt buộc với engine native); dùng `$CODER_HOME/coder models`, `$CODER_HOME/agent`, `$CODER_HOME/lib/sandbox-exec.sh` |
| `DYSTOPIA_MODEL` | model native dùng; phải có trong danh sách của MTH |
| `DYSTOPIA_PI_SDK` | ghi đè đường dẫn `dist/index.js` của Pi SDK |
| `DYSTOPIA_NATIVE_DRIVER` | file `.mjs` driver giả cho test (không dùng khi chạy thật) |

`DYSTOPIA_VERSION` vẫn ghi đè `meta.version` như commit A. Không thêm biến key mới.

## 8. Prompt, pha tổng, khử trùng lặp (commit C)

- Prompt hệ thống hiện là **bản tạm** `prompts/placeholder.md`, dòng đầu ghi rõ
  "TẠM — chờ Kosma viết prompt thật (commit C)". Không chép prompt của OCR.
- Chưa nạp `rules-overlay/` dạng file rule và chưa có pha tổng.
- Chưa khử trùng lặp finding.

## 9. Test

```
node --test test/*.test.mjs
```

- `test/native-tools.test.mjs`: path traversal/tuyệt đối/symlink/`.git`, cắt 400 dòng,
  `git_show` rev lạ, lọc file bỏ qua; một test chạy thật qua `sandbox-exec` và tự skip khi
  thiếu `CODER_HOME`/bwrap.
- `test/native-finding.test.mjs`: từ chối severity sai, line ngoài head, file không đổi,
  evidence rỗng; agent sửa lại trong cùng lượt.
- `test/native-loop.test.mjs`: `max-tool-calls` → `truncated` giữ finding, token/phase-split,
  concurrency, `meta.model`, giới hạn mặc định.
- `test/native-coder.test.mjs`: `CODER_HOME` thiếu → 64, `DYSTOPIA_MODEL` lạ → 64, model mặc
  định khác model viết code, `dystopia models` với coder giả.
- `test/engine.test.mjs`: hợp đồng chung chạy trên cả adapter ocr (output giả) và native
  (driver giả) qua `validateResult`.
- `test/bench.test.mjs`: ngưỡng hit rate, truyền limits, bench native (tự skip nếu thiếu
  sandbox).

Fixture chỉ dùng tên giả (`src/file1.ts`, ...), không chứa code hay tên file thật của repo core.

## 10. Exit code

| Code | Khi nào |
|---|---|
| `64` | thiếu `CODER_HOME`, `$CODER_HOME/coder`, `DYSTOPIA_MODEL` lạ, thiếu `--from`/`--to`, dùng `-c` với native, giới hạn sai, không tìm thấy Pi SDK/model |
| `1` | lỗi chạy engine/output sai schema |
| `0` | review xong (kể cả khi `truncated`) |
