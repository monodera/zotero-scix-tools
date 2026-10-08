# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tools that clean up an astronomy-heavy Zotero library against NASA SciX (the ADS API): merge duplicates, upgrade arXiv preprints to published metadata, add SciX/Publisher link attachments, replace ADS URLs with SciX URLs, and tidy arXiv vs. publisher PDFs. `README.md` (English) and `README.ja.md` (Japanese) are the user-facing docs; keep them in sync when behavior changes.

There is no build system, no test suite, no package manifest, and no git history in this directory.

## Commands

The Python side is standard library only (Python ≥ 3.8); no dependencies to install.

```bash
uv run python/make_queries.py [--workdir ~/Zotero/scix-work] [--round 1|2]
uv run python/build_plan.py   [--workdir ~/Zotero/scix-work]
```

The Zotero scripts cannot run outside Zotero (they use `Zotero.*`, `IOUtils`, `PathUtils`, top-level `await` and top-level `return`). To syntax-check one locally, parse it as an async function body:

```bash
node -e 'const AF=Object.getPrototypeOf(async function(){}).constructor; new AF(require("fs").readFileSync(process.argv[1],"utf8"))' zotero/3_apply.js
```

Real runs happen in Zotero → Tools → Developer → Run JavaScript with "Run as async function" ticked (e.g. `pbcopy < zotero/1_resolve.js`, then paste).

## Architecture

A plan-then-apply pipeline that alternates between Zotero (JS) and Python, communicating only through JSON files in the work dir `scix-work/` under the Zotero data directory (`~/Zotero/scix-work/` by default; JS uses `Zotero.DataDirectory.dir`, Python uses `--workdir`):

1. `zotero/1_resolve.js` (read-only) — snapshots every item (`snap`), queries SciX by arXiv ID / DOI / bibcode in batches, then by title+author+year, and writes `resolve.json` = `{snap, out, docs, adsStandaloneNotes, adsNoteBodies, stats}`.
2. `python/make_queries.py` — builds relaxed extra searches → `queries.json`. Round 2 reads `resolution.json` from a prior `build_plan.py` run and drops the year restriction.
3. `zotero/2_query.js` (read-only, resumable) — runs `queries.json` → `query-results.json`.
4. `python/build_plan.py` — the decision logic. Loads both result files via `scix_common.Data` (query-result docs are merged into `docs`), applies optional `manual.json` overrides (format: `examples/manual.example.json`), and writes `plan.json` = `{ops, pdf}`, `resolution.json`, and `review.html` for human review.
5. `zotero/3_apply.js` — executes `plan.ops`. Op kinds: `merge`, `update`, `link`, `setUrl`, `noteReplace`; each op has a stable `id` (e.g. `merge:<KEY>`, `upd:<KEY>`, `link:scix:<KEY>`). Completed ids are recorded in `apply-log.jsonl` and skipped on rerun, so changing how ids are formed breaks resumability. `setUrl` skips if the item's URL no longer equals `from` (changed since planning). First real (non-dry) run backs up the DB with `VACUUM INTO` into `scix-work/backup/`.
6. `zotero/4_trash_arxiv_pdf.js`, `5_needs_list.js`, `6_absorb.js` — PDF handling driven by `plan.pdf` (4, 5) or by recently added items matched on DOI (6).

Key conventions:

- **Each Zotero script must be self-contained** because it is pasted into Zotero individually. Helpers such as the SciX HTTP wrapper (`ads()` with 429/5xx retry), progress window, `log()` to `*.jsonl`, and the arXiv-vs-publisher PDF classifier (`STAMP` regex on pages 1–2, `classify`, `hasFileAnnotations`) are intentionally duplicated across files — when fixing one copy, fix all copies.
- Python shared logic (title normalization/similarity, hit acceptance, `is_pub`, `pub_doi`, `own_ax`, the SciX field list `FL`) lives in `python/scix_common.py`. `FL` must match the `FL` constant in the JS scripts.
- Each JS script's settings are in a `CFG` block at the top; `3_apply.js`, `4_trash_arxiv_pdf.js` and `6_absorb.js` default to `dryRun: true` (`5_needs_list.js` has no `CFG` and edits tags directly).
- Tags written to the library use the `_scix:` prefix (`_scix:published-update`, `_scix:needs-pub-pdf`, `_scix:pdf-published`, `_scix:arxiv-pdf-annotated`).
- GitHub Issues and PRs for this repo are written in Japanese.
- Language: header first line of each JS file and Python docstrings are English; inline code comments, console/progress messages and many `print` outputs are Japanese. Follow the surrounding file.

## Constraints from the design

- Never add automated downloading from publishers (bot management, subscription terms). Publisher PDFs are fetched manually via Zotero Connector and folded in by `6_absorb.js`.
- The resolve/query steps must stay read-only on the library; only `3_apply.js`, `4_trash_arxiv_pdf.js`, `5_needs_list.js` (tags only) and `6_absorb.js` modify it.
- SciX API limit is 5,000 requests/day; scripts report `X-RateLimit-Remaining`.
- Items with only similar titles are listed for review, never auto-merged.
- `.gitignore` excludes the token (`ads_token.txt`) and all library-specific outputs; do not add real work-dir files to the repo.
