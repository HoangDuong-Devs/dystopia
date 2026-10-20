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
| `lib/engine/native/config.mjs` | `DYSTOPIA_HOME`, agent dir, env file, Pi SDK, `$CODER_HOME/lib/sandbox-exec.sh` |
| `lib/engine/native/coder.mjs` | đọc `agent/models.json` của Dystopia, chọn model; CLI `dystopia models` |
| `lib/engine/native/tools.mjs` | 4 tool chỉ đọc + chạy git qua `sandbox-exec` của MTH + danh sách file bỏ qua |
| `lib/engine/native/finding.mjs` | `report_finding`, kiểm schema, sắp xếp finding |
| `lib/engine/native/loop.mjs` | pha file, pool song song có giới hạn, ngân sách token/tool call, meta |
| `lib/engine/native/driver-pi.mjs` | driver Pi SDK (`createAgentSession`, `noTools` + `customTools`) |
| `lib/engine/native/limits.mjs` | chuẩn hóa `--max-tool-calls`, `--max-tokens`, `--phase-split`, `--concurrency` |
| `lib/engine/native/prompts/placeholder.md` | prompt tạm, chờ Kosma viết prompt thật ở commit C |
| `agent/models.json` | provider `commandcode` của Dystopia; `apiKey` chỉ ghi **tên biến** `COMMANDCODE_API_KEY` |

`normalize`, `--text`, `bench` và CLI không biết engine nào bên dưới: tất cả đi qua hợp đồng
`{ findings, meta }` ở `docs/engine.md`.

## 2. Cấu hình riêng của Dystopia và chọn model

- `DYSTOPIA_HOME` mặc định là thư mục cài; đặt biến này để dùng thư mục dữ liệu khác.
  Launcher export `DYSTOPIA_HOME` cho mọi tiến trình node con.
- Env file là `${DYSTOPIA_ENV_FILE:-$DYSTOPIA_HOME/.env}`. Trước khi source, launcher kiểm
  quyền bằng `stat -c %a`: nếu có bất kỳ bit group/other nào (rộng hơn `600`) thì in
  `dystopia: <file> có quyền XXX, rộng hơn 600; chạy chmod 600 ...` ra stderr **không kèm nội
  dung file** và exit 64. `dystopia --version` chạy trước bước này nên không cần env file.
- Agent dir là `${DYSTOPIA_AGENT_DIR:-$DYSTOPIA_HOME/agent}`. Dystopia **không** dùng
  `$CODER_HOME/agent`, không đọc `auth.json` hay `.env` của MTH.
- `agent/models.json` (commit trong repo) khai báo provider `commandcode`,
  `baseUrl=https://api.commandcode.ai/provider/v1`, `api=openai-completions`, và
  `apiKey: "$COMMANDCODE_API_KEY"` — Pi hiểu `$NAME`/`${NAME}` là **env interpolation**, nên
  đây là tên biến môi trường chứ không phải giá trị key literal. Key thật chỉ nằm trong
  `$DYSTOPIA_HOME/.env` (hoặc env của tiến trình).
- `listModels()` đọc và parse `agent/models.json`; không chạy `$CODER_HOME/coder models`.
  File thiếu/hỏng/không có model → exit 64, lỗi chỉ nêu đường dẫn, không in nội dung.
- `CODER_HOME` vẫn **bắt buộc** với engine native nhưng **chỉ** để tìm
  `$CODER_HOME/lib/sandbox-exec.sh`; thiếu biến hoặc thiếu file → exit 64.
- `DYSTOPIA_MODEL` đặt → phải có trong `models.json`, khớp theo tên model (kèm `provider/`
  nếu có); không có → exit 64 kèm danh sách.
- Không đặt `DYSTOPIA_MODEL` → model đầu tiên trong danh sách ưu tiên
  `deepseek/deepseek-v4.1-flash`, `Qwen/Qwen3.8-Omni-Flash` có trong config **và khác model
  viết code**; không có thì model đầu tiên khác model viết code; không còn ứng viên → exit 64.
- Model viết code là `CODER_DEFAULT_MODEL`, mặc định `deepseek-v4.1-flash-fast`.
  So sánh "khác" theo tên model sau khi bỏ tiền tố provider/vendor, nên
  `deepseek-v4.1-flash-fast` khác `deepseek-v4.1-flash`. Với `agent/models.json` hiện tại,
  mặc định Dystopia chọn `deepseek/deepseek-v4.1-flash`.
- `meta.model` là model **thật** driver báo (session của Pi), không phải nhãn đã chọn.
- `dystopia models` in danh sách từ `agent/models.json` của Dystopia, đánh dấu `*` model đang
  chọn và `[code]` model viết code. Output không bao giờ chứa giá trị key.

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
chỉ đọc của MTH, không mạng. Đây là **cách duy nhất** engine native còn dùng `CODER_HOME`.
Engine không tự viết sandbox và không chạy lệnh nào khác ngoài git đọc.

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
  `$DYSTOPIA_HOME/../pi/packages/coding-agent/dist/index.js` (không còn suy ra từ `CODER_HOME`);
- đặt `PI_CODING_AGENT_DIR=$DYSTOPIA_AGENT_DIR` (mặc định `$DYSTOPIA_HOME/agent`) và truyền
  `modelsPath=$DYSTOPIA_AGENT_DIR/models.json`; không cần `auth.json`, key lấy từ biến
  `COMMANDCODE_API_KEY` mà `models.json` trỏ tới;
- `SessionManager.inMemory()`, settings trong bộ nhớ (tắt compaction/retry);
- `noTools: true` + `customTools` đúng 5 tool ở trên;
- model lấy từ `coder.mjs`, thinking `off`, system prompt là `prompts/placeholder.md`.

Sau `session.prompt`, driver kiểm assistant message cuối. Nếu `stopReason` là `error` (hoặc
`prompt` ném lỗi), driver ném `EngineError` kèm thông điệp lỗi provider, đã thay mọi giá trị
bằng `COMMANDCODE_API_KEY`/`OCR_LLM_TOKEN` thành `[REDACTED]`:

- `NATIVE_AUTH`, exit `21`: provider trả 401/403 (lỗi xác thực);
- `NATIVE_RATE`, exit `23`: provider trả 429 (giới hạn tốc độ);
- `NATIVE_ERROR`, exit `20`: lỗi provider khác.

Lỗi này propagate qua `loop.mjs`/`index.mjs` tới CLI: review thoát khác 0 và **không ghi**
output rỗng. Không thông điệp lỗi nào của driver in env hay giá trị key; lỗi chỉ nêu đường dẫn
file/biến hoặc nội dung lỗi provider đã scrub.

Test không gọi LLM thật: truyền driver giả qua tham số `driver` của adapter hoặc đặt
`DYSTOPIA_NATIVE_DRIVER=<file .mjs>` (file export `createDriver(options)`).

## 7. Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `DYSTOPIA_HOME` | thư mục dữ liệu/cấu hình của Dystopia; mặc định thư mục cài. Launcher export cho node con |
| `DYSTOPIA_ENV_FILE` | env file; mặc định `$DYSTOPIA_HOME/.env` (phải có quyền không rộng hơn 600) |
| `DYSTOPIA_AGENT_DIR` | agent dir riêng; mặc định `$DYSTOPIA_HOME/agent` |
| `COMMANDCODE_API_KEY` | key thật, chỉ nằm trong env/.env; `agent/models.json` chỉ ghi tên biến này |
| `CODER_HOME` | thư mục cài MTH, **chỉ** để tìm `$CODER_HOME/lib/sandbox-exec.sh` (bắt buộc với engine native) |
| `DYSTOPIA_MODEL` | model native dùng; phải có trong `agent/models.json` của Dystopia |
| `DYSTOPIA_PI_SDK` | ghi đè đường dẫn `dist/index.js` của Pi SDK |
| `DYSTOPIA_NATIVE_DRIVER` | file `.mjs` driver giả cho test (không dùng khi chạy thật) |

`DYSTOPIA_VERSION` vẫn ghi đè `meta.version` như commit A. `OCR_LLM_*` vẫn dùng cho engine OCR;
launcher map `OCR_LLM_TOKEN` từ `COMMANDCODE_API_KEY` khi biến này chưa đặt và **không unset**
`COMMANDCODE_API_KEY` trước khi engine native cần. Không output/meta/log nào chứa token.

**Xoay key:** trên fc1 có **hai bản** `.env` cần cập nhật cùng lúc — `.env` của MTH và
`$DYSTOPIA_HOME/.env` của Dystopia. Tên biến: `COMMANDCODE_API_KEY`, `OCR_LLM_TOKEN`,
`OCR_LLM_MODEL`, `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `DYSTOPIA_MODEL`, `CODER_HOME`.

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
- `test/native-coder.test.mjs`: đọc `agent/models.json` (không cần `CODER_HOME`),
  `CODER_HOME` thiếu khi review native → 64, `DYSTOPIA_MODEL` lạ → 64, model mặc định khác
  model viết code, `dystopia models`.
- `test/no-key-leak.test.mjs`: đặt key giả trong `.env` 600 rồi chạy `models`, review native
  (driver giả) và các đường lỗi; khẳng định key không có trong stdout/stderr/output JSON;
  `.env` 644/640 bị từ chối exit 64, 600 được nhận.
- `test/engine.test.mjs`: hợp đồng chung chạy trên cả adapter ocr (output giả) và native
  (driver giả) qua `validateResult`.
- `test/bench.test.mjs`: ngưỡng hit rate, truyền limits, bench native (tự skip nếu thiếu
  sandbox).

Fixture chỉ dùng tên giả (`src/file1.ts`, ...), không chứa code hay tên file thật của repo core.

## 10. Exit code

| Code | Khi nào |
|---|---|
| `64` | `.env` rộng hơn 600, thiếu `agent/models.json`, thiếu `CODER_HOME` hoặc `$CODER_HOME/lib/sandbox-exec.sh`, `DYSTOPIA_MODEL` lạ, thiếu `--from`/`--to`, dùng `-c` với native, giới hạn sai, không tìm thấy Pi SDK/model |
| `20` | lỗi provider khác khi chạy Pi (assistant `stopReason: error`) |
| `21` | provider trả 401/403 (lỗi xác thực, `NATIVE_AUTH`) |
| `23` | provider trả 429 (giới hạn tốc độ, `NATIVE_RATE`) |
| `1` | lỗi chạy engine/output sai schema |
| `0` | review xong (kể cả khi `truncated`) |
