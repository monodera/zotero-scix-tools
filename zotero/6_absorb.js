// =====================================================================
// Step 7: after saving publisher versions with Zotero Connector, merge those new items into the existing ones by DOI and trash the arXiv PDF. Dry-run first.
//
// 6_absorb.js — Zotero Connector で保存した出版版を既存アイテムに統合する
//   1. 直近 CFG.days 日に追加されたアイテムのうち、DOI が既存（より古い）アイテムと一致するものを探す
//   2. 既存アイテムを残して統合（新アイテムのPDF・スナップショットは既存アイテムへ移る。メタデータは既存側を維持）
//   3. 既存アイテムに出版版PDFがあれば、arXiv版PDFをゴミ箱へ（PDFに書き込み注釈があるものは残す）
//      タグ _scix:needs-pub-pdf を外し、_scix:pdf-published を付ける
//
// 実行方法: Run JavaScript（Run as async function にチェック）。まず dryRun:true で確認。
// =====================================================================
const CFG = {
  dryRun: true,     // true: 何が統合されるか表示するだけ
  days: 7,          // 何日前までに追加されたアイテムを対象にするか
  trashArxivPdf: true,
};
const LIB = Zotero.Libraries.userLibraryID;
const DIR = PathUtils.join(Zotero.DataDirectory.dir, 'scix-work');
const LOG = PathUtils.join(DIR, 'absorb-log.jsonl');
async function log(rec) {
  rec.t = new Date().toISOString(); if (CFG.dryRun) rec.dry = true;
  const line = JSON.stringify(rec) + '\n';
  try { await IOUtils.writeUTF8(LOG, line, { mode: 'appendOrCreate' }); }
  catch (e) { const p = (await IOUtils.exists(LOG)) ? await Zotero.File.getContentsAsync(LOG) : ''; await Zotero.File.putContentsAsync(LOG, p + line); }
}

const STAMP = /arXiv:\s?(\d{4}\.\d{4,5}|[a-z\-]+(\.[A-Z]{2})?\/\d{7})v\d+/i;
const STAMP_NOSPACE = /arxiv:(\d{4}\.\d{4,5}|[a-z\-]+(\.[a-z]{2})?\/\d{7})v\d+/i;
function isArxivText(t) {
  if (STAMP.test(t)) return true;
  const z = t.replace(/\s+/g, '');
  return STAMP_NOSPACE.test(z) || STAMP_NOSPACE.test(z.split('').reverse().join(''));
}
async function pageText(att) {
  try { const r = await Zotero.PDFWorker.getFullText(att.id, 2); if (r && r.text) return r.text; } catch (e) {}
  try { const t = await att.attachmentText; if (t) return t.slice(0, 15000); } catch (e) {}
  return null;
}
async function classify(att) {
  if (/arxiv\.org/i.test(att.getField('url') || '')) return 'arxiv';
  if (!(await att.fileExists())) return 'unknown';
  const t = await pageText(att);
  if (t == null || t.trim().length < 200) return 'unknown';
  return isArxivText(t) ? 'arxiv' : 'published';
}
const ANNOT = /\/Subtype\s*\/(Highlight|Underline|StrikeOut|Squiggly|Text|FreeText|Ink|Square|Circle|Polygon|PolyLine|Caret|Stamp)\b/;
async function hasFileAnnotations(att) {
  try {
    const p = await att.getFilePathAsync(); if (!p) return false;
    const bytes = await IOUtils.read(p); let s = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return ANNOT.test(s);
  } catch (e) { return true; }
}
const normDoi = d => (d || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');

// 全アイテムの DOI 索引
const all = (await Zotero.Items.getAll(LIB, true, false)).filter(i => i.isRegularItem());
const byDoi = new Map();
for (const it of all) {
  const d = normDoi(it.getField('DOI'));
  if (!d || d.startsWith('10.48550/')) continue;
  if (!byDoi.has(d)) byDoi.set(d, []);
  byDoi.get(d).push(it);
}
const since = Date.now() - CFG.days * 86400e3;
const added = it => Zotero.Date.sqlToDate(it.dateAdded, true).getTime();

const res = { merged: 0, pdfPublished: 0, stillNeeds: 0, skipped: 0 };
const lines = [];
for (const [doi, items] of byDoi) {
  if (items.length < 2) continue;
  const fresh = items.filter(i => added(i) >= since);
  const old = items.filter(i => added(i) < since).sort((a, b) => added(a) - added(b));
  if (!fresh.length || !old.length) continue;
  if (old.length > 1) { res.skipped++; lines.push('SKIP(既存が複数) ' + doi); continue; }
  const master = old[0];
  lines.push(`${master.getField('title').slice(0, 70)}  ←  新規${fresh.length}件`);
  if (CFG.dryRun) { await log({ doi, master: master.key, fresh: fresh.map(f => f.key) }); continue; }
  await Zotero.Items.merge(master, fresh);
  res.merged += fresh.length;
  // PDF 判定
  const kids = Zotero.Items.get(master.getAttachments(false)).filter(a => a.isPDFAttachment());
  const cls = []; for (const a of kids) cls.push([a, await classify(a)]);
  if (cls.some(([, c]) => c === 'published')) {
    res.pdfPublished++;
    if (CFG.trashArxivPdf) for (const [a, c] of cls) {
      if (c !== 'arxiv') continue;
      if (await hasFileAnnotations(a)) { master.addTag('_scix:arxiv-pdf-annotated'); continue; }
      a.deleted = true; await a.saveTx();
    }
    master.removeTag('_scix:needs-pub-pdf'); master.addTag('_scix:pdf-published');
  } else res.stillNeeds++;
  await master.saveTx();
  await log({ doi, master: master.key, fresh: fresh.map(f => f.key), kids: cls.map(([a, c]) => a.key + ':' + c) });
}
return (CFG.dryRun ? '[DRY-RUN] 統合予定:\n' : '') + lines.slice(0, 50).join('\n') + (lines.length > 50 ? `\n…他${lines.length - 50}件` : '') + '\n' + JSON.stringify(res);
