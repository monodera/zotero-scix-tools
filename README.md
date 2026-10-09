# zotero-scix-tools

These scripts clean up an astronomy-heavy Zotero library by matching it against [NASA Science Explorer (SciX)](https://scixplorer.org/).

[日本語の説明はこちら (Japanese README)](README.ja.md)

## What it does

- **Merges duplicates.** Items that share an arXiv ID, a DOI or a SciX bibcode are merged, including arXiv-preprint / published-version pairs. If the titles differ a lot, the items are merged only when the first author also matches and they share an arXiv ID or match the same SciX record by an identifier; otherwise they are listed for review. Items that only have similar titles are listed for review, not merged.
- **Updates arXiv papers to the published version.** The item type becomes Journal Article or Conference Paper, and the journal, volume, issue, pages, date, DOI and title come from the published record. The arXiv ID is kept in Extra.
- **Adds links.** Each matched item gets a "NASA SciX" link attachment and a "Publisher" link attachment (doi.org).
- **Replaces ADS links with SciX links.** This covers the URL field, attachment URLs and notes.
- **Tidies PDFs.** When an item already has the publisher PDF, the arXiv PDF goes to the trash. PDFs that contain highlights or comments are kept.
- **Helps you fetch publisher PDFs by hand.** It makes a clickable list of items that still lack one. After you save papers with Zotero Connector, a script folds them into your existing items.

Items that are not in SciX get a Publisher link if they have a DOI. Anything left over is listed for manual work.

## Design

- **Everything runs inside Zotero** through *Tools → Developer → Run JavaScript*. You do not need to quit Zotero, and the changes sync like ordinary edits.
- **Plan first, then apply.** The pipeline runs match (read-only) → build plan (Python) → human review → apply. Applying supports a dry run, resumes after an interruption, and takes a database backup right before every real run.
- **No automated publisher downloads.** Major publishers (IOP/AAS, OUP, EDP, …) block automated access with bot management. Working around that breaches typical subscription terms and can get your whole institution's access suspended. Fetch publisher PDFs in your normal browser with Zotero Connector. For bulk access, ask your library about the publisher's text-and-data-mining (TDM) channel.

## Requirements

- Zotero 7 or later (tested with 10.0.6)
- A SciX API token. Log in at scixplorer.org and go to Settings → API Token; the same token works for ADS.
- Python ≥ 3.8 (standard library only)

## Layout

```
zotero/                 paste into Zotero's Run JavaScript window
  1_resolve.js          match against SciX (read-only)          -> scix-work/resolve.json
  2_query.js            extra SciX searches (read-only)          -> scix-work/query-results.json
  3_apply.js            apply the plan (merge/update/links/ADS)
  4_trash_arxiv_pdf.js  trash arXiv PDFs where a publisher PDF exists
  5_needs_list.js       tag + list items still lacking a publisher PDF
  6_absorb.js           merge Connector-saved versions into existing items
python/
  make_queries.py       build extra queries                      -> scix-work/queries.json
  build_plan.py         build the plan and a review page         -> scix-work/plan.json, review.html
examples/manual.example.json   format for manual overrides
```

Working files go to `scix-work/` inside your Zotero data directory, which is usually `~/Zotero/scix-work/`.

## Steps

### Running a script

Every script runs the same way:

1. In Zotero, open **Run JavaScript** and tick **"Run as async function"**.
2. Paste the whole script. On macOS you can run `pbcopy < zotero/1_resolve.js` and then press ⌘V.
3. Press Run.

Settings are in the `CFG` block at the top of each script.

### 0. Prepare

1. Back up `zotero.sqlite`. Quit Zotero before you copy it.
2. Create the working directory and save your token:

```bash
mkdir -p ~/Zotero/scix-work
read -rs SCIX_TOKEN   # paste the token and press Enter (it is not echoed or saved in shell history)
(umask 077; printf '%s' "$SCIX_TOKEN" > ~/Zotero/scix-work/ads_token.txt)   # readable only by you
unset SCIX_TOKEN
```

### 1. Match (read-only)

1. Run `1_resolve.js`. Try `limit: 30` first, then run with `limit: 0`. About 7,000 items take roughly 1,200 requests and 20–30 minutes.
2. Build the extra queries:

```bash
cd python
python3 make_queries.py
```

3. Run `2_query.js`.

### 2. Build and review the plan

```bash
python3 build_plan.py
```

Open `~/Zotero/scix-work/review.html`. The item keys in it are `zotero://` links that open the item in Zotero.

- **Many items still unmatched?** Run `python3 make_queries.py --round 2`, then `2_query.js`, then `build_plan.py` again. Round 2 searches without the year restriction, and looks for the published version of items that the extra searches matched only to an arXiv e-print.
- **Need to fix a match, block a merge or add a link you found yourself?** Write `scix-work/manual.json` (see `examples/`) and rerun `build_plan.py`. Values under `fields` override both the item's current values and those from SciX. `3_apply.js` skips operations already recorded in `apply-log.jsonl`, so `fields` added after an item has been updated are not written on a rerun; edit those items in Zotero by hand.

### 3. Apply

1. Run `3_apply.js` with `dryRun: true`. Details go to `dryrun-report.json`.
2. Run it with `dryRun: false, limit: 5, only: ['merge']` and check the merges in Zotero. Every real run that has operations left to apply first writes a backup of the database to `scix-work/backup/`. Old backups are never deleted automatically, so remove the ones you no longer need by hand (keep the oldest one, taken before the first real run, until you are sure you will not start over).
3. Run it with `limit: 0, only: null`. Operations that already ran are skipped (see `apply-log.jsonl`).

Updated items are tagged `_scix:published-update`. Delete the tag once you have reviewed them.

### 4. PDFs

1. Run `4_trash_arxiv_pdf.js` as a dry run, then for real.
2. Run `5_needs_list.js`. It tags items without a publisher PDF as `_scix:needs-pub-pdf` and writes `needs-pub-pdf.html` / `.csv`. It has no dry run: it only adds and removes this tag, and rerunning it updates the tags to the current state.
3. Open the DOI links in the list and save each paper with Zotero Connector. Each one becomes a new item.
4. Run `6_absorb.js`, dry run first. It merges the new items into the existing ones by DOI and trashes the arXiv PDF.

The scripts tell an arXiv PDF from a publisher PDF by the arXiv stamp on pages 1–2 (`arXiv:XXXX.XXXXXvN [astro-ph…]`). PDFs they cannot classify, such as image-only scans, are left alone. If your PDFs are linked files, emptying the trash does not delete them from disk.

## After the first clean-up

There are three kinds of follow-up work. Before any of them changes your library, quit Zotero and back up `zotero.sqlite`: `3_apply.js` makes its own backup before each real run, but `4_trash_arxiv_pdf.js`, `5_needs_list.js` and `6_absorb.js` do not. Always paste the scripts from the current version of this repository, not copies kept elsewhere.

### A. Publisher PDFs for papers already in your library

Do this whenever you have saved publisher versions with Zotero Connector. It needs none of the other steps and makes no SciX requests.

1. Open `~/Zotero/scix-work/needs-pub-pdf.html` (made by `5_needs_list.js`) and save the papers from their DOI links with Zotero Connector. Each one becomes a new item.
2. Run `6_absorb.js`, dry run first. It merges each new item into the existing item with the same DOI and, once a publisher PDF is attached, trashes the arXiv PDF (annotated PDFs are kept). A new item whose title differs a lot from the existing one is not merged and is listed as `SKIP`, because the DOI may be wrong or shared by a whole proceedings volume.
   - Items added within the last `days` days (`CFG`, 7 by default) count as the newly saved ones. If you saved them longer ago, raise `days`. An item added within that window is never used as the existing one.
   - The existing item needs the publisher DOI in its DOI field. The items in the list normally do.
   - If two or more existing items have the same DOI, they are skipped (`SKIP(既存が複数)`). Merge those duplicates first, with B or by hand.
3. Optionally run `5_needs_list.js` again to refresh the list and the `_scix:needs-pub-pdf` tags.

### B. Papers you add from arXiv

Nothing is needed when you add a paper. Every one to three months, run the whole pipeline once:

1. Back up `zotero.sqlite`, and keep `scix-work/apply-log.jsonl`.
2. Run steps 1–3 above. `make_queries.py` writes a new `queries.json`, and `2_query.js` then runs all of its queries again instead of reusing last time's results. If `2_query.js` stops part-way (for example at the daily limit), running it again continues where it stopped.
3. `3_apply.js` skips operations that `apply-log.jsonl` records as done (`ok` or `noop`); ones that were skipped or failed are tried again. Papers added since the last run are processed as in the first run, including merges with copies you already have (which item is kept is decided as in the first run). Papers that SciX now matches to a different record than last time — typically arXiv e-prints that have since been published — are updated to the new record, including their "NASA SciX" and "Publisher" links.
4. Run `4_trash_arxiv_pdf.js` (dry run first) and `5_needs_list.js`, then fetch the publisher PDFs with A.

### C. Going over the whole library again

For example after updating these scripts.

- **Usually, run B.** With `apply-log.jsonl` kept, what gets applied is papers added since the last run, papers whose SciX match changed, and operations the previous plan did not contain (for example a merge or an ADS replacement that the updated scripts now find). Operations already recorded as done are not redone, even if the updated scripts would now produce a different result for them.
- **To start over from scratch**, quit Zotero, put the backup taken right before the first real run (the oldest `scix-work/backup/zotero.sqlite.pre-apply-…`) back as `zotero.sqlite`, move `apply-log.jsonl` aside, and follow the steps from the beginning. Everything you changed in the library after that backup is lost. If you use Zotero sync, mind the server-side state.
- Moving only `apply-log.jsonl` aside, without restoring the backup, makes `3_apply.js` update every item again: values you corrected by hand are overwritten and the `_scix:published-update` tag comes back. Do this only if that is what you want.

## Notes

- The SciX API allows 5,000 requests per day. The scripts report how many remain.
- Do not edit the affected items while applying. Items whose URL changed after planning are skipped.
- To roll back, quit Zotero and put a file from `scix-work/backup/` back as `zotero.sqlite`. If you use Zotero sync, mind the server-side state.
- Use at your own risk.

## License

MIT
