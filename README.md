# zotero-scix-tools

These scripts clean up an astronomy-heavy Zotero library by matching it against [NASA Science Explorer (SciX)](https://scixplorer.org/).

[日本語の説明はこちら (Japanese README)](README.ja.md)

## What it does

- **Merges duplicates.** Items that share an arXiv ID, a DOI or a SciX bibcode are merged, including arXiv-preprint / published-version pairs. Items that only have similar titles are listed for review, not merged.
- **Updates arXiv papers to the published version.** The item type becomes Journal Article or Conference Paper, and the journal, volume, issue, pages, date, DOI and title come from the published record. The arXiv ID is kept in Extra.
- **Adds links.** Each matched item gets a "NASA SciX" link attachment and a "Publisher" link attachment (doi.org).
- **Replaces ADS links with SciX links.** This covers the URL field, attachment URLs and notes.
- **Tidies PDFs.** When an item already has the publisher PDF, the arXiv PDF goes to the trash. PDFs that contain highlights or comments are kept.
- **Helps you fetch publisher PDFs by hand.** It makes a clickable list of items that still lack one. After you save papers with Zotero Connector, a script folds them into your existing items.

Items that are not in SciX get a Publisher link if they have a DOI. Anything left over is listed for manual work.

## Design

- **Everything runs inside Zotero** through *Tools → Developer → Run JavaScript*. You do not need to quit Zotero, and the changes sync like ordinary edits.
- **Plan first, then apply.** The pipeline runs match (read-only) → build plan (Python) → human review → apply. Applying supports a dry run, resumes after an interruption, and takes a database backup right before the first real run.
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
printf '%s' 'YOUR_SCIX_TOKEN' > ~/Zotero/scix-work/ads_token.txt
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
2. Run it with `dryRun: false, limit: 5, only: ['merge']` and check the merges in Zotero. The first real run writes a backup to `scix-work/backup/`.
3. Run it with `limit: 0, only: null`. Operations that already ran are skipped (see `apply-log.jsonl`).

Updated items are tagged `_scix:published-update`. Delete the tag once you have reviewed them.

### 4. PDFs

1. Run `4_trash_arxiv_pdf.js` as a dry run, then for real.
2. Run `5_needs_list.js`. It tags items without a publisher PDF as `_scix:needs-pub-pdf` and writes `needs-pub-pdf.html` / `.csv`.
3. Open the DOI links in the list and save each paper with Zotero Connector. Each one becomes a new item.
4. Run `6_absorb.js`, dry run first. It merges the new items into the existing ones by DOI and trashes the arXiv PDF.

The scripts tell an arXiv PDF from a publisher PDF by the arXiv stamp on pages 1–2 (`arXiv:XXXX.XXXXXvN [astro-ph…]`). PDFs they cannot classify, such as image-only scans, are left alone. If your PDFs are linked files, emptying the trash does not delete them from disk.

## Notes

- The SciX API allows 5,000 requests per day. The scripts report how many remain.
- Do not edit the affected items while applying. Items whose URL changed after planning are skipped.
- To roll back, quit Zotero and put a file from `scix-work/backup/` back as `zotero.sqlite`. If you use Zotero sync, mind the server-side state.
- Use at your own risk.

## License

MIT
