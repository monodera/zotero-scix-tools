// =====================================================================
// Step 5: for items that already have a publisher PDF, move the arXiv PDF to the trash (no downloads). Dry-run first.
//
// 4_trash_arxiv_pdf.js — 出版版PDFが既にあるアイテムから arXiv版PDFをゴミ箱へ（ダウンロードなし）
//   ・plan.json の対象アイテムについて、添付PDFを1〜2ページ目の arXiv 刻印で判定
//   ・「出版版」と判定されたPDFが1つ以上あれば、「arXiv版」と判定されたPDFをゴミ箱へ
//   ・注釈（Zoteroリーダーで付けたもの・PDFファイルに書き込まれたもの）があるものは残し、タグ _scix:arxiv-pdf-annotated を付ける
//   ・判定できないPDF（画像PDF・ファイルなし）には触れない
//   ・リンクファイルなので、ゴミ箱を空にしてもPDFファイル自体はディスクに残ります
//
// 実行方法: Run JavaScript（Run as async function にチェック）。まず dryRun:true で件数を確認。
// =====================================================================
const CFG = { dryRun: true };
const DIR = PathUtils.join(Zotero.DataDirectory.dir, 'scix-work');
const LIB = Zotero.Libraries.userLibraryID;
const plan = JSON.parse(await Zotero.File.getContentsAsync(PathUtils.join(DIR, 'plan.json')));
const LOG = PathUtils.join(DIR, 'trash-arxiv-log.jsonl');
async function log(rec) {
  rec.t = new Date().toISOString(); if (CFG.dryRun) rec.dry = true;
  const line = JSON.stringify(rec) + '\n';
  try { await IOUtils.writeUTF8(LOG, line, { mode: 'appendOrCreate' }); }
  catch (e) { const p = (await IOUtils.exists(LOG)) ? await Zotero.File.getContentsAsync(LOG) : ''; await Zotero.File.putContentsAsync(LOG, p + line); }
}
let pw = null, pline = null;
try { pw = new Zotero.ProgressWindow({ closeOnClick: false }); pw.changeHeadline('trash arXiv PDF' + (CFG.dryRun ? ' (dry-run)' : '')); pline = new pw.ItemProgress(null, 'starting…'); pw.show(); } catch (e) {}
const progress = (t, p) => { try { pline.setText(t); if (p != null) pline.setProgress(p); } catch (e) {} };

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
// Zotero リーダーで付けた注釈は PDF ではなく DB に保存されるので、そちらも見る
async function hasAnnotations(att) {
  try { if (att.getAnnotations(true).length) return true; } catch (e) {}
  return hasFileAnnotations(att);
}

const cnt = { items: 0, trashed: 0, keptAnnotated: 0 };
const sample = [];
for (let i = 0; i < plan.pdf.length; i++) {
  if (i % 25 === 0) progress(`${i}/${plan.pdf.length}`, 100 * i / plan.pdf.length);
  const it = Zotero.Items.getByLibraryAndKey(LIB, plan.pdf[i].key);
  if (!it || it.deleted) continue;
  const kids = Zotero.Items.get(it.getAttachments(false)).filter(a => a.isPDFAttachment());
  if (kids.length < 2) continue;
  const cls = []; for (const a of kids) cls.push([a, await classify(a)]);
  if (!cls.some(([, c]) => c === 'published') || !cls.some(([, c]) => c === 'arxiv')) continue;
  cnt.items++;
  const done = [];
  for (const [a, c] of cls) {
    if (c !== 'arxiv') continue;
    if (await hasAnnotations(a)) { cnt.keptAnnotated++; if (!CFG.dryRun) it.addTag('_scix:arxiv-pdf-annotated'); continue; }
    if (!CFG.dryRun) { a.deleted = true; await a.saveTx(); }
    cnt.trashed++; done.push(a.key);
  }
  if (!CFG.dryRun) { it.removeTag('_scix:needs-pub-pdf'); it.addTag('_scix:pdf-published'); await it.saveTx(); }
  if (sample.length < 15) sample.push(it.getField('title').slice(0, 70));
  await log({ key: it.key, trashed: done, kids: cls.map(([a, c]) => a.key + ':' + c) });
}
progress('done'); try { pw.startCloseTimer(6000); } catch (e) {}
return (CFG.dryRun ? '[DRY-RUN] ' : '') + JSON.stringify(cnt) + '\n例:\n' + sample.join('\n');
