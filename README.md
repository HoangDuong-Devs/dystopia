# Dystopia

Dystopia is FireMoth's code-review pre-filter: an LLM review tool built on
[OpenCodeReview](https://github.com/alibaba/open-code-review) (pinned at `9867a3d`).
It only produces findings; approval stays with the reviewer.

## Install
1. Clone `alibaba/open-code-review` at `9867a3d` (default location `$HOME/firemoth/tools/opencodereview`, override with `OCR_SRC`; ref override with `OCR_REF`). Treat it as read-only.
2. Need Go >= 1.21 (or set `GO_BIN`).
3. Run `./install.sh`. It builds `bin/opencodereview`, creates `.env` from `.env.example`, and prints OK/WARN/FAIL lines ending with `Kết quả: sẵn sàng.`

## Usage
Run inside the repo to review:
```
dystopia review --output r.json                        # uncommitted changes, normalized findings
dystopia review --from main --to feat/x --output r.json  # branch range (merge-base)
dystopia review -c abc123 --output r.json              # one commit
dystopia review -c abc123 -p                           # preview files to review
dystopia review --text                                 # normalized findings as text on stdout
dystopia review --engine ocr --dir ../core             # pick the engine, pick the repo
dystopia review --raw --output raw.json                # raw OCR output (old behavior)
dystopia review --format text                          # explicit format, normalization skipped
dystopia bench                                        # run every benchmark case once
dystopia bench --runs 3 --case aeb2fc6                 # repeat runs, select cases
dystopia bench --engine ocr                            # engine used by the benchmark
dystopia --version                                     # dystopia <VERSION> (<git short HEAD|nogit>)
```
By default `review` runs the `ocr` engine: OCR with `--format json` into a temp file, normalized
to `{ meta, findings }`, printed on stdout (or written to `--output`). `--text` prints
`[severity] file:line-end_line rule — claim` lines instead. `--raw` returns the untouched OCR
JSON; passing `--format` yourself also skips normalization. `--engine ocr|native` picks the
review engine (default `ocr`) and `--dir <repo>` the repository (default: current directory).
See `docs/engine.md` for the engine contract, registry and how to add one, and
`docs/ocr-output.md` for the schema and severity mapping.

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
| `COMMANDCODE_API_KEY` | API key, mapped to `OCR_LLM_TOKEN` |
| `OCR_LLM_MODEL` | model (default `deepseek/deepseek-v4.1-flash-fast`) |
| `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `OCR_LLM_TOKEN` | provider overrides (default CommandCode, OpenAI-compatible) |
| `DYSTOPIA_BENCH_DIR` | benchmark data directory (default `$HOME/firemoth/tools/dystopia-bench`) |
| `DYSTOPIA_BENCH_REVIEWER` | command used by `bench` instead of `dystopia review` |

Never commit `.env`. See `GUIDE.md` (Vietnamese) for details, `docs/engine.md` for the engine
contract, `docs/ocr-output.md` for the output schema and `NOTICE` for attribution.
