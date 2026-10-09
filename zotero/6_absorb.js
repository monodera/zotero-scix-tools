// =====================================================================
// Step 7: after saving publisher versions with Zotero Connector, merge those new items into the existing ones by DOI and trash the arXiv PDF. Dry-run first.
//
// 6_absorb.js — Zotero Connector で保存した出版版を既存アイテムに統合する
//   1. 直近 CFG.days 日に追加されたアイテムのうち、DOI が既存（より古い）アイテムと一致するものを探す
//      タイトルが大きく異なるもの（類似度 0.5 未満）は、DOI の誤記などとみなして統合しない（SKIP として表示）
//   2. 既存アイテムを残して統合（新アイテムのPDF・スナップショットは既存アイテムへ移る。メタデータは既存側を維持）
//   3. 既存アイテムに出版版PDFがあれば、arXiv版PDFをゴミ箱へ（注釈があるものは残す）
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
  // URL のホストが arxiv.org（またはそのサブドメイン）のときだけ arXiv 版とみなす
  if (/^https?:\/\/([a-z0-9-]+\.)*arxiv\.org(?:[:\/?#]|$)/i.test(att.getField('url') || '')) return 'arxiv';
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
// Zotero リーダーで付けた注釈は PDF ではなく DB に保存されるので、そちらも見る
async function hasAnnotations(att) {
  try { if (att.getAnnotations().length) return true; } catch (e) {}
  return hasFileAnnotations(att);
}
const normDoi = d => (d || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');

// タイトル類似度（python/scix_common.py の tsim と同じ：文字列の一致率 difflib.SequenceMatcher.ratio と単語の Jaccard の大きい方）
// difflib の autojunk（200文字以上の文字列で頻出文字を無視する）は再現していない
function plainTitle(t) {
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  t = String(t || '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (m, d, h, n) => {
    const c = d ? +d : h ? parseInt(h, 16) : null;
    return c == null ? ent[n.toLowerCase()] : c <= 0x10FFFF ? String.fromCodePoint(c) : m;
  });
  t = t.replace(/<[^>]+>/g, ' ').replace(/\$[^$]*\$/g, ' ').replace(/\\[a-zA-Z]+/g, ' ');
  return t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const normTitle = t => (plainTitle(t).match(/[a-z0-9]+/g) || []).join(' ');
function seqRatio(a, b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) { if (!b2j.has(b[j])) b2j.set(b[j], []); b2j.get(b[j]).push(j); }
  let matched = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    let bi = alo, bj = blo, bk = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        nj.set(j, k);
        if (k > bk) { bi = i - k + 1; bj = j - k + 1; bk = k; }
      }
      j2len = nj;
    }
    if (!bk) continue;
    matched += bk;
    if (alo < bi && blo < bj) queue.push([alo, bi, blo, bj]);
    if (bi + bk < ahi && bj + bk < bhi) queue.push([bi + bk, ahi, bj + bk, bhi]);
  }
  return 2 * matched / (a.length + b.length);
}
function tsim(a, b) {
  a = normTitle(a); b = normTitle(b);
  if (!a || !b) return 0;
  const wa = new Set(a.split(' ')), wb = new Set(b.split(' '));
  const inter = [...wa].filter(w => wb.has(w)).length;
  return Math.max(seqRatio(a, b), inter / Math.max(1, new Set([...wa, ...wb]).size));
}

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

const res = { merged: 0, pdfPublished: 0, stillNeeds: 0, skipped: 0, titleMismatch: 0 };
const lines = [];
for (const [doi, items] of byDoi) {
  if (items.length < 2) continue;
  const fresh = items.filter(i => added(i) >= since);
  const old = items.filter(i => added(i) < since).sort((a, b) => added(a) - added(b));
  if (!fresh.length || !old.length) continue;
  if (old.length > 1) { res.skipped++; lines.push('SKIP(既存が複数) ' + doi); continue; }
  const master = old[0];
  const mt = master.getField('title');
  // DOI は予稿集全体で共有されたり誤記されたりするので、タイトルも似ているものだけを統合する（build_plan.py と同じ基準）
  const ok = [], mismatch = [];
  for (const f of fresh) (tsim(mt, f.getField('title')) >= 0.5 ? ok : mismatch).push(f);
  for (const f of mismatch) {
    res.titleMismatch++;
    lines.push(`SKIP(タイトルが大きく異なる) ${doi}\n    既存 ${master.key}: ${mt.slice(0, 70)}\n    新規 ${f.key}: ${f.getField('title').slice(0, 70)}`);
  }
  if (!ok.length) { await log({ doi, master: master.key, mismatch: mismatch.map(f => f.key) }); continue; }
  lines.push(`${mt.slice(0, 70)}  ←  新規${ok.length}件` + ok.map(f => `\n    ← ${f.getField('title').slice(0, 70)}`).join(''));
  if (CFG.dryRun) { await log({ doi, master: master.key, fresh: ok.map(f => f.key), mismatch: mismatch.map(f => f.key) }); continue; }
  await Zotero.Items.merge(master, ok);
  res.merged += ok.length;
  // PDF 判定
  const kids = Zotero.Items.get(master.getAttachments(false)).filter(a => a.isPDFAttachment());
  const cls = []; for (const a of kids) cls.push([a, await classify(a)]);
  if (cls.some(([, c]) => c === 'published')) {
    res.pdfPublished++;
    if (CFG.trashArxivPdf) for (const [a, c] of cls) {
      if (c !== 'arxiv') continue;
      if (await hasAnnotations(a)) { master.addTag('_scix:arxiv-pdf-annotated'); continue; }
      a.deleted = true; await a.saveTx();
    }
    master.removeTag('_scix:needs-pub-pdf'); master.addTag('_scix:pdf-published');
  } else res.stillNeeds++;
  await master.saveTx();
  await log({ doi, master: master.key, fresh: ok.map(f => f.key), mismatch: mismatch.map(f => f.key), kids: cls.map(([a, c]) => a.key + ':' + c) });
}
return (CFG.dryRun ? '[DRY-RUN] 統合予定:\n' : '') + lines.slice(0, 50).join('\n') + (lines.length > 50 ? `\n…他${lines.length - 50}件` : '') + '\n' + JSON.stringify(res);
