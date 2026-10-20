# Engine native (v0.3 commit C2a)

Engine `native` chạy lõi Pi qua thư viện, thay vì gọi binary OCR. Commit B mới có
**pha file**: mỗi file thay đổi một lượt agent, tool chỉ đọc, `report_finding` kiểm schema
ngay, giới hạn tool call/token, `meta.truncated`, `meta.per_file`, `meta.errors` và ghi output
tăng dần. Pha tổng, khử trùng lặp và prompt/rules
thật là **commit C**.

Commit C2a đưa mặc định của engine native về sát template review của Alibaba
OpenCodeReview (OCR) @9867a3d: 100 lượt tool/file, ngân sách token tổng 0 = không giới hạn,
8 file song song, timeout 15 phút/file và 300 giây/request, `read_file` 500 dòng,
`grep` 100 dòng, `maxTokens` 16384 cho mỗi model.

```
dystopia review --engine native --from <base> --to <head> [--dir <repo>] \
  [--max-tool-calls N] [--max-tokens N] [--phase-split F] [--concurrency N]
dystopia models
```

`--phase-split` vẫn được chấp nhận để không phá hợp đồng CLI nhưng **bị bỏ qua
(deprecated)**; OCR không có khái niệm chia ngân sách theo pha. Không có cờ mới.

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
| `lib/engine/native/limits.mjs` | chuẩn hóa `--max-tool-calls`, `--max-tokens`, `--concurrency`; hằng timeout/round có ghi nguồn OCR |
| `lib/engine/native/prompts/file-review.md` | prompt hệ thống pha file (Kosma, pass 1 theo từng file) |
| `lib/engine/native/prompts/cross-file.md` | prompt pass 2 cross-file của Kosma; **chưa dùng**, để dành cho pha cross-file sau này |
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

`repo` là worktree của `--dir`, nhưng **mọi tool đọc nội dung của commit head** qua git,
không đọc file trên đĩa. Vì vậy checkout của `--dir` có thể đang ở commit khác head (ví dụ
branch khác, commit cũ) mà kết quả vẫn đúng. Engine chuẩn hóa `--to` thành sha đầy đủ
(`git rev-parse --verify <rev>^{commit}`) trước khi tạo tool; tool chỉ nhận sha đầy đủ.

| Tool | Việc |
|---|---|
| `read_file(path, from?, to?)` | đọc nội dung file ở **head** bằng `git cat-file -p <head>:<path>`; tối đa **500 dòng** (OCR `internal/tool/file_read.go:12` `fileReadMaxLines = 500`) và **~60000 ký tự** (trần ký tự chỉ có ở Dystopia) mỗi lần; `from`/`to` là 1-based, bao gồm hai đầu. Không truyền dải thì đọc **từ dòng 1**, tối đa 500 dòng (không còn cửa sổ ±40 quanh hunk). Bị cắt thì kết quả có `[đã cắt: dòng X-Y; gọi lại với from/to]` kèm tổng số dòng |
| `list_changed_files()` | `git diff --name-status` + `--numstat` base..head, kèm `+/-`; bỏ file lock/sinh tự động/binary |
| `grep(pattern, path_glob)` | `git grep -n ... <head> -- <pathspec>`, bỏ tiền tố `<head>:` khỏi đường dẫn trong output; tối đa **100 dòng khớp** (OCR `internal/tool/code_search.go:18` `gitGrepMaxCount = 100`) và **~60000 ký tự** (trần ký tự chỉ có ở Dystopia), có ghi chú `[đã cắt: hiển thị X/Y dòng khớp; ...]` khi cắt |
| `git_show(rev, path)` | chỉ nhận `rev` là base hoặc head; tối đa **200 dòng** và **~12000 ký tự**, có ghi chú khi cắt. **Không có OCR tương đương**, giữ trần hiện tại của Dystopia |
| `report_finding(...)` | xem mục 4 |

Danh sách bỏ qua lấy từ `rules-overlay/ignore.txt` (nếu có) cộng mặc định:
`*.lock`, `package-lock.json`, `bun.lockb`, `dist/**`, `*.min.js`, và file binary nhận ra qua
numstat `-`. File đã xoá ở head không vào danh sách review (không thể báo finding theo dòng head).

Chặn đường dẫn cho mọi tool (kiểm theo **cây git của revision**, không theo đĩa):

- từ chối đường dẫn tuyệt đối;
- từ chối mọi đoạn `..` (kể cả khi chuẩn hóa vẫn nằm trong repo);
- từ chối path có đoạn `.git`;
- đường dẫn phải trỏ tới entry tồn tại trong cây head (`git cat-file -t`/`git ls-tree`), là
  blob thường; thư mục, entry không tồn tại và mọi symlink trong cây đều bị từ chối;
- symlink không bao giờ được đi theo ra đĩa;
- với glob của `grep`, các đoạn tĩnh trước ký tự glob cũng được kiểm theo cây head.

Mọi lệnh git (kể cả `cat-file`/`ls-tree`/`grep` đọc nội dung head) chạy qua
`$CODER_HOME/lib/sandbox-exec.sh '<lệnh git>'` với `CODER_WORKDIR=<repo>`: sandbox bwrap
chỉ đọc của MTH, không mạng. Đây là **cách duy nhất** engine native còn dùng `CODER_HOME`.
Engine không tự viết sandbox và không chạy lệnh nào khác ngoài git đọc.

Biến môi trường truyền vào `sandbox-exec.sh` là **allowlist**, không phải bản sao `process.env`:
`PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, các biến `GIT_*`, các biến `CODER_*`
cấu hình sandbox và `CODER_WORKDIR=<repo>`. Mọi tên khớp `/KEY|TOKEN|SECRET|PASSWORD/i`
và mọi biến ngoài allowlist đều bị bỏ, nên `COMMANDCODE_API_KEY`/`OCR_LLM_TOKEN` không bao giờ
đi vào tiến trình sandbox.

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
2. Mỗi file một session agent; số file chạy song song tối đa `--concurrency`
   (mặc định **8**, OCR `cmd/opencodereview/shared_flags.go:233`).
3. `--max-tool-calls` (mặc định **100/file**, OCR `task_template.json:38` +
   `internal/llmloop/loop.go:388`). Khi số tool call chạm trần, tool đọc trả lỗi
   `... hãy report_finding ngay`; engine chạy **đúng một grace round** (`FINAL_PROMPT`)
   trong đó chỉ `report_finding` được phép, tool khác trả lỗi bảo model báo ngay
   (OCR `loop.go:560-566`). Sau grace round file dừng, finding đã báo vẫn giữ,
   file vào `meta.truncated` với `reason: "max-tool-calls"`.
4. `--max-tokens` (**mặc định 0 = không giới hạn**, OCR `shared_flags.go:238` và `:60`).
   Khi > 0, tổng token của **cả lần review** được kiểm trước mỗi lượt LLM:
   file đang chạy được **một grace round** rồi dừng với `reason: "budget"`;
   không file mới nào được khởi động, các file đó vào `meta.truncated` và
   `meta.errors` với `error: "skipped-budget"`. Không abort session.
5. File tự nhiên dừng khi model kết thúc lượt mà không gọi tool. Nếu có re-prompt,
   đếm số lượt assistant liên tiếp không gọi tool và dừng ở **3**
   (OCR `loop.go:389` `maxConsecutiveEmptyRounds = 3`).
6. Timeout: **15 phút/file** (× số review round, hiện là 1; OCR
   `shared_flags.go:234` + `:52`, `agent.go:677`) và **300 giây/request LLM**
   (OCR `shared_flags.go:52` `OCR_LLM_TIMEOUT` mặc định 300). File quá hạn bị abort
   và vào `meta.errors` là `{file, error: "timeout"}`; file khác vẫn chạy.
7. Lỗi 429/rate được **retry có backoff** (mặc định tối đa 3 lần, 1s rồi nhân đôi).
   Mỗi lần retry cộng vào `retries` của file và `retries_total` của `meta`.
   Hết retry vẫn là `NATIVE_RATE`, exit `23`.
8. File lỗi provider/stream (không phải `NATIVE_AUTH`/`NATIVE_RATE`) được **retry một lần với
   session mới**. Lỗi lần hai vào `meta.errors` dạng `{file, error}` (error đã scrub key),
   finding của các file khác vẫn giữ. Review trả exit `0` nếu còn ít nhất một file chạy xong;
   exit `20` nếu mọi file đều lỗi (kể cả khi tất cả bị `skipped-budget`).
9. Khi có `--output`, sau mỗi file engine ghi **nguyên tử** (file tạm + rename) JSON finding
   đến hiện tại với `meta.partial: true`. Lần ghi cuối đặt `meta.partial: false`, nên crash
   giữa chừng vẫn giữ được các file đã xong.
10. Không có tool ghi file/chạy lệnh cho agent.

`meta.per_file` là mảng `{file, tokens_in, tokens_out, tool_calls, rounds, retries, truncated,
reason, rejected_reports, final_text}` cho từng file (cùng dữ liệu với
`meta.phases.file.files`); `meta.errors` liệt kê file lỗi và `meta.partial` cho biết lần ghi
hiện tại là tạm hay cuối. `meta.retries_total` là tổng retry 429 của cả review.

- `rounds` là số assistant message (lượt) của file; driver Pi báo qua `onRound`, driver
  không báo thì engine đếm mỗi `prompt()` là một lượt.
- `retries` là số lần retry 429 của file.
- `reason` là `"budget"`, `"max-tool-calls"`, `"empty-rounds"` hoặc `null`.

- `rejected_reports: {count, reasons}` đếm **mọi** lần gọi `report_finding` bị validation từ
  chối trong file đó; `reasons` là lý do từ chối (đã scrub `COMMANDCODE_API_KEY`/`OCR_LLM_TOKEN`),
  tối đã 20 phần tử trong khi `count` vẫn đếm đủ.
- `final_text` là 500 ký tự đầu của text assistant **cuối cùng** trong lượt chạy của file (đã
  scrub key), `null` nếu không có text nào.

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
  "concurrency": 8,
  "limits": { "max_tool_calls": 100, "max_tokens": 0 },
  "per_file": [
    { "file": "src/file1.ts", "tokens_in": 1200, "tokens_out": 300, "tool_calls": 4,
      "rounds": 2, "retries": 0, "truncated": true, "reason": "budget",
      "rejected_reports": { "count": 1, "reasons": ["line 999 vượt quá 3 dòng của \"src/file1.ts\" ở head"] },
      "final_text": "Đã báo 2 finding cho file này." }
  ],
  "errors": [{ "file": "src/file2.ts", "error": "Pi báo lỗi provider: Stream ended without finish_reason" }],
  "retries_total": 0,
  "partial": false,
  "phases": {
    "file": {
      "tokens_in": 1200,
      "tokens_out": 300,
      "tool_calls": 4,
      "duration_ms": 1200,
      "files": [
        { "file": "src/file1.ts", "tokens_in": 1200, "tokens_out": 300, "tool_calls": 4,
          "rounds": 2, "retries": 0, "truncated": true, "reason": "budget",
          "rejected_reports": { "count": 1, "reasons": ["line 999 vượt quá 3 dòng của \"src/file1.ts\" ở head"] },
          "final_text": "Đã báo 2 finding cho file này." }
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
- model lấy từ `coder.mjs`; driver **không truyền `thinkingLevel`** và `agent/models.json`
  không bật `reasoning`, nên request provider không có `reasoning_effort`, `reasoning`,
  `thinking`, `enable_thinking` hay `temperature`. OCR cũng không gửi trường reasoning nào
  (`internal/llm/client.go:641,953`: chỉ temperature nếu được cấu hình);
- system prompt mặc định là `prompts/file-review.md`.

Sau `session.prompt`, driver kiểm assistant message cuối. Nếu `stopReason` là `error` (hoặc
`prompt` ném lỗi), driver ném `EngineError` kèm thông điệp lỗi provider, đã thay mọi giá trị
bằng `COMMANDCODE_API_KEY`/`OCR_LLM_TOKEN` thành `[REDACTED]`:

- `NATIVE_AUTH`, exit `21`: provider trả 401/403 (lỗi xác thực);
- `NATIVE_RATE`, exit `23`: provider trả 429 (giới hạn tốc độ);
- `NATIVE_ERROR`, exit `20`: lỗi provider khác.

Lỗi provider của một file không làm hỏng cả review: `loop.mjs` retry file đó đúng một lần bằng
session mới rồi mới ghi vào `meta.errors`. `NATIVE_AUTH`/`NATIVE_RATE` vẫn dừng toàn bộ review
với exit `21`/`23`.

Lỗi này propagate qua `loop.mjs`/`index.mjs` tới CLI: review thoát khác 0 và **không ghi**
output rỗng. Không thông điệp lỗi nào của driver in env hay giá trị key; lỗi chỉ nêu đường dẫn
file/biến hoặc nội dung lỗi provider đã scrub.

Test không gọi LLM thật: truyền driver giả qua tham số `driver` của adapter hoặc đặt
`DYSTOPIA_NATIVE_DRIVER=<file .mjs>` (file export `createDriver(options)`).

### 6.1. Mặc định so với OCR @9867a3d

| Mặc định | Dystopia native | OCR | Nguồn OCR |
|---|---|---|---|
| Tool call/file | 100 | 100 | `internal/config/template/task_template.json:38`, `internal/llmloop/loop.go:388` |
| Lượt assistant rỗng liên tiếp | 3 | 3 | `internal/llmloop/loop.go:389` |
| Ngân sách token tổng | 0 = không giới hạn | 0 = không giới hạn | `cmd/opencodereview/shared_flags.go:238`, `:60` |
| Concurrency | 8 | 8 | `cmd/opencodereview/shared_flags.go:233` |
| Timeout/file | 15 phút × review round (hiện 1) | 15 phút × `MAX_REVIEW_ROUNDS` | `shared_flags.go:234`, `:52`, `agent/agent.go:677` |
| Timeout/request LLM | 300 s | 300 s (`OCR_LLM_TIMEOUT`) | `shared_flags.go:52` |
| `maxTokens` model | 16384 | `MAX_COMPLETION_TOKENS` 16384 | `task_template.json:45` |
| `read_file` | 500 dòng, không range → từ dòng 1 | 500 dòng | `internal/tool/file_read.go:12` |
| `grep` | 100 dòng khớp | 100 | `internal/tool/code_search.go:18` |
| Grace round | 1 lượt, chỉ `report_finding` | `runGraceRound` | `internal/llmloop/loop.go:560-566` |

Trần ký tự `read_file`/`grep` (60000) và trần `git_show` (200 dòng/12000 ký tự) là của
Dystopia; OCR không có hằng tương đương cho `git_show`.

### 6.2. Khác biệt đã biết so với OCR

- **ReLocation chưa có**: OCR dùng `internal/llmloop/loop.go:760-800` và
  `internal/diff/relocation.go` để dời finding khi dòng bị lệch; Dystopia chưa làm.
- **Plan/grouping chưa có**: OCR dùng `task_template.json:39-42` và `internal/agent/grouping.go`;
  Dystopia chỉ có pha file.
- **Context ceiling 200k + memory compression chưa có**: OCR `task_template.json:44` và
  `internal/llmloop/compression.go`; sẽ làm ở C2b.
- **`MAX_REVIEW_ROUNDS = 2` chưa có**: OCR `task_template.json:43`; hiện review round = 1.
  C2b sẽ thêm context ceiling/compression và review round 2.

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

- Prompt hệ thống pha file là `prompts/file-review.md` (Kosma viết, pass 1 theo từng file);
  `loadSystemPrompt()` nạp file này khi không truyền `systemPrompt`/`promptPath`.
  Không chép prompt của OCR.
- `prompts/cross-file.md` (Kosma, pass 2 cross-file) đã có trong repo nhưng **chưa dùng**;
  nó để dành cho pha cross-file sau này.
- Chưa nạp `rules-overlay/` dạng file rule và chưa có pha tổng.
- Chưa khử trùng lặp finding.

## 9. Test

```
node --test test/*.test.mjs
```

- `test/native-tools.test.mjs`: path traversal/tuyệt đối/symlink/`.git`, `read_file` cắt 500
dòng (từ dòng 1 khi không có range), `grep` 100 dòng, `git_show` 200 dòng,
  env allowlist của `sandbox-exec` (không lọt key/token), `git_show` rev lạ, lọc file bỏ qua;
  test đọc head qua git khi checkout ở đĩa là commit cũ (`read_file`/`grep` trả nội dung head,
  file đã xoá ở head bị từ chối); một test chạy thật qua `sandbox-exec` và tự skip khi thiếu
  `CODER_HOME`/bwrap.
- `test/native-finding.test.mjs`: từ chối severity sai, line ngoài head, file không đổi,
  evidence rỗng; agent sửa lại trong cùng lượt.
- `test/native-loop.test.mjs`: `max-tool-calls` → grace round chỉ report, ngân sách token tổng
  → grace + `reason: "budget"`, mặc định 100/0/8, timeout, concurrency, `meta.model`,
  `meta.per_file` (`rounds`, `retries`, `rejected_reports`, `final_text`), prompt
  `file-review.md` được truyền cho driver.
- `test/native-c2a.test.mjs`: khóa hằng OCR, `maxTokens` trong `agent/models.json`, budget
  `skipped-budget`, retry 429 + `retries_total`, timeout file, report_finding theo head
  (Kosma: commit A 3 dòng/B 10 dòng), không có `thinkingLevel`; test payload thật qua Pi SDK
  dùng HTTP server 127.0.0.1 (tự skip nếu không có SDK).
- `test/native-isolation.test.mjs`: một file lỗi stream hai lần → file khác vẫn có finding,
  `meta.errors` đúng file, output `partial: true` ghi sau file đầu, exit 0; lỗi một lần rồi
  thành công → không có `meta.errors`; mọi file lỗi → exit 20.
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
| `20` | lỗi provider khác khi chạy Pi (`NATIVE_ERROR`), hoặc **mọi file** đều lỗi sau retry (`NATIVE_ALL_FILES_FAILED`); output tạm `partial: true` có thể còn lại |
| `21` | provider trả 401/403 (lỗi xác thực, `NATIVE_AUTH`) |
| `23` | provider trả 429 (giới hạn tốc độ, `NATIVE_RATE`) |
| `1` | lỗi chạy engine/output sai schema |
| `0` | review xong (kể cả khi `truncated`) |
