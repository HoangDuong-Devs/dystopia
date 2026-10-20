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
dystopia review --raw --output raw.json                # raw OCR output (old behavior)
dystopia review --format text                          # explicit format, normalization skipped
```
By default `review` runs OCR with `--format json` into a temp file, normalizes the output to
`{ meta, findings }` and prints it (or writes it to `--output`). `--text` prints
`[severity] file:line-end_line rule — claim` lines instead. `--raw` returns the untouched OCR
JSON; passing `--format` yourself also skips normalization. See `docs/ocr-output.md` for the
schema and severity mapping.

`meta` carries `tool`, `version`, `base`, `head`, `model`, `tokens_in`, `tokens_out` and
`duration_ms`; each finding has `severity` (`chặn`/`nên sửa`/`gợi ý`), `file`, `line`,
`end_line`, `rule`, `claim`, `evidence` and `confidence` (currently `null`: OCR has none).
If `rules-overlay/rule.json` exists and no `--rule` is passed, it is added automatically for `review`/`scan`.

## Environment (`.env`, or another file via `DYSTOPIA_ENV_FILE`)
| Variable | Meaning |
|---|---|
| `COMMANDCODE_API_KEY` | API key, mapped to `OCR_LLM_TOKEN` |
| `OCR_LLM_MODEL` | model (default `deepseek/deepseek-v4.1-flash-fast`) |
| `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `OCR_LLM_TOKEN` | provider overrides (default CommandCode, OpenAI-compatible) |

Never commit `.env`. See `GUIDE.md` (Vietnamese) for details, `docs/ocr-output.md` for the
output schema and `NOTICE` for attribution.
