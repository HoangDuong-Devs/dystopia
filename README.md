# Dystopia

Dystopia is FireMoth's code-review pre-filter: an LLM review tool built on
[OpenCodeReview](https://github.com/alibaba/open-code-review) (pinned at `9867a3d`).
It only produces findings; approval stays with the reviewer.

## Install
1. Clone `alibaba/open-code-review` at `9867a3d` (default location `$HOME/firemoth/tools/opencodereview`, override with `OCR_SRC`; ref override with `OCR_REF`). Treat it as read-only.
2. Need Go >= 1.21 (or set `GO_BIN`).
3. Run `./install.sh`. It builds `bin/opencodereview`, creates `.env` from `.env.example` with mode 600 (it never copies a key from MTH) and prints OK/WARN/FAIL lines ending with `Kết quả: sẵn sàng.` Fill in `COMMANDCODE_API_KEY` yourself.

## Usage
Run inside the repo to review:
```
dystopia review --output r.json                        # uncommitted changes, normalized findings
dystopia review --from main --to feat/x --output r.json  # branch range (merge-base)
dystopia review -c abc123 --output r.json              # one commit
dystopia review -c abc123 -p                           # preview files to review
dystopia review --text                                 # normalized findings as text on stdout
dystopia review --engine ocr --dir ../core             # pick the engine, pick the repo
dystopia review --engine native --from main --to feat/x  # native engine (file phase, commit B)
dystopia review --engine native --from main --to feat/x --max-tokens 300000 --concurrency 2
dystopia review --raw --output raw.json                # raw OCR output (old behavior)
dystopia review --format text                          # explicit format, normalization skipped
dystopia bench                                        # run every benchmark case once
dystopia bench --runs 3 --case aeb2fc6                 # repeat runs, select cases
dystopia bench --engine ocr                            # engine used by the benchmark
dystopia models                                        # native models from Dystopia's agent/models.json
dystopia --version                                     # dystopia <VERSION> (<git short HEAD|nogit>)
```
By default `review` runs the `ocr` engine: OCR with `--format json` into a temp file, normalized
to `{ meta, findings }`, printed on stdout (or written to `--output`). `--text` prints
`[severity] file:line-end_line rule — claim` lines instead. `--raw` returns the untouched OCR
JSON; passing `--format` yourself also skips normalization. `--engine ocr|native` picks the
review engine (default `ocr`) and `--dir <repo>` the repository (default: current directory).
See `docs/engine.md` for the engine contract, registry and how to add one, and
`docs/ocr-output.md` for the schema and severity mapping.

The `native` engine uses the Pi core in-process instead of the OCR binary. Commit B has the
file phase only: one agent turn per changed file, read-only tools (`read_file`,
`list_changed_files`, `grep`, `git_show`), `report_finding` validated on every call, and
`--max-tool-calls` / `--max-tokens` / `--phase-split` / `--concurrency` limits with
`meta.truncated`. Native requires `--from` and `--to` (no `-c`). Its key and model config are its
own: the launcher reads `${DYSTOPIA_ENV_FILE:-$DYSTOPIA_HOME/.env}` (mode broader than 600 → exit
64) and the agent dir is `${DYSTOPIA_AGENT_DIR:-$DYSTOPIA_HOME/agent}`; it never uses
`$CODER_HOME/agent` or MTH's `.env`. Models come from `agent/models.json` (provider
`commandcode`; `apiKey` holds only the env var name `COMMANDCODE_API_KEY`); `DYSTOPIA_MODEL`
selects one by name and the default is a model different from the coding model
(`CODER_DEFAULT_MODEL`). `dystopia models` lists them and marks the Dystopia and coding
models. `CODER_HOME` is still required but only to locate
`$CODER_HOME/lib/sandbox-exec.sh`; git reads run through it. The per-file system prompt is
`lib/engine/native/prompts/file-review.md` (Kosma's pass 1); `prompts/cross-file.md` is kept for
a later cross-file pass. The summary phase and deduplication are still commit C. See
`docs/native.md`.

`meta` carries `tool`, `version`, `engine`, `base`, `head`, `model`, `tokens_in`, `tokens_out`
and `duration_ms`; each finding has `severity` (`chặn`/`nên sửa`/`gợi ý`), `file`, `line`,
`end_line`, `rule`, `claim`, `evidence` and `confidence` (currently `null`: OCR has none).
`version` comes from the `VERSION` file at the repo root (`0.3.0-dev`); `DYSTOPIA_VERSION`
overrides it for tests. If `rules-overlay/rule.json` exists and no `--rule` is passed, it is
added automatically for `review`/`scan`.

`bench` reviews each case from `<bench dir>/cases/*.json` (a detached worktree per run, engine
called through the contract), scores findings against the expected bugs and writes a JSON
result to `<bench dir>/results/`; the document records the engine used. The data directory
defaults to `$HOME/firemoth/tools/dystopia-bench` and can be overridden with
`DYSTOPIA_BENCH_DIR`. `--runs N` repeats every case and reports hit rates, `--case <id>` selects
cases, `--engine` picks the engine and the table starts with `engine: <name>`. Exit code is 0
when all non-skipped cases pass, 1 when any case fails and 64 on bad configuration or
arguments. See `docs/bench.md` for the case schema and scoring rules.

## Environment (`.env`, or another file via `DYSTOPIA_ENV_FILE`)
| Variable | Meaning |
|---|---|
| `DYSTOPIA_HOME` | Dystopia data/config directory; defaults to the install directory (exported to node children) |
| `DYSTOPIA_ENV_FILE` | env file; defaults to `$DYSTOPIA_HOME/.env` (mode must not be broader than 600) |
| `DYSTOPIA_AGENT_DIR` | Dystopia agent dir; defaults to `$DYSTOPIA_HOME/agent` |
| `COMMANDCODE_API_KEY` | API key; native reads it directly, OCR gets it mapped to `OCR_LLM_TOKEN` |
| `OCR_LLM_MODEL` | model (default `deepseek/deepseek-v4.1-flash-fast`) |
| `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `OCR_LLM_TOKEN` | provider overrides (default CommandCode, OpenAI-compatible) |
| `DYSTOPIA_BENCH_DIR` | benchmark data directory (default `$HOME/firemoth/tools/dystopia-bench`) |
| `DYSTOPIA_BENCH_REVIEWER` | command used by `bench` instead of `dystopia review` |
| `CODER_HOME` | MTH install directory, only to locate `$CODER_HOME/lib/sandbox-exec.sh` (required by the native engine) |
| `DYSTOPIA_MODEL` | native model to use; must exist in Dystopia's `agent/models.json` |
| `DYSTOPIA_PI_SDK` | override the Pi SDK `dist/index.js` path |
| `DYSTOPIA_NATIVE_DRIVER` | test-only `.mjs` fake driver (never used in normal runs) |

Never commit `.env`, and never print it or the key. **Key rotation on fc1 updates two copies:**
MTH's `.env` and Dystopia's `$DYSTOPIA_HOME/.env`. Variable names: `COMMANDCODE_API_KEY`,
`OCR_LLM_TOKEN`, `OCR_LLM_MODEL`, `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `DYSTOPIA_MODEL`,
`CODER_HOME`. See `GUIDE.md` (Vietnamese) for details, `docs/engine.md` for the engine
contract, `docs/native.md` for the native engine, `docs/ocr-output.md` for the output schema
and `NOTICE` for attribution.
