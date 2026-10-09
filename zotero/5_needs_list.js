// =====================================================================
// Step 6: tag items that still lack a publisher PDF and write a clickable HTML/CSV list for manual retrieval with Zotero Connector. No downloads.
//
// 5_needs_list.js — 出版版PDFがまだ無いアイテムに印を付け、手動取得用のリストを作る
//   ・既存PDFを判定（arXiv版 / 出版版）し、出版版が無いアイテムにタグ _scix:needs-pub-pdf を付ける
//   ・出版版PDFが付いた後で再実行すると、そのアイテムのタグは外れる（何度でも実行可）
//   ・~/Zotero/scix-work/needs-pub-pdf.html と .csv を出力（DOI/SciXリンク付き、雑誌別）
//   ※ダウンロードやPDFのゴミ箱移動は一切しません
//
// 実行方法: Run JavaScript（Run as async function にチェック）
// =====================================================================
const TAG = '_scix:needs-pub-pdf';
const DIR = PathUtils.join(Zotero.DataDirectory.dir, 'scix-work');
const LIB = Zotero.Libraries.userLibraryID;
const plan = JSON.parse(await Zotero.File.getContentsAsync(PathUtils.join(DIR, 'plan.json')));

let pw = null, pline = null;
try { pw = new Zotero.ProgressWindow({ closeOnClick: false }); pw.changeHeadline('needs-pub-pdf'); pline = new pw.ItemProgress(null, 'starting…'); pw.show(); } catch (e) {}
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
  // URL のホストが arxiv.org（またはそのサブドメイン）のときだけ arXiv 版とみなす
  if (/^https?:\/\/([a-z0-9-]+\.)*arxiv\.org(?:[:\/?#]|$)/i.test(att.getField('url') || '')) return 'arxiv';
  if (!(await att.fileExists())) return 'unknown';
  const t = await pageText(att);
  if (t == null || t.trim().length < 200) return 'unknown';
  return isArxivText(t) ? 'arxiv' : 'published';
}
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// = + - @ などで始まるセルは表計算ソフトが数式として扱うので、先頭に ' を付けて文字列にする
const csvq = s => { s = String(s || ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };

const rows = []; const cnt = { needs: 0, hasPublished: 0, gone: 0, unknownOnly: 0 };
for (let i = 0; i < plan.pdf.length; i++) {
  const e = plan.pdf[i];
  if (i % 25 === 0) progress(`${i}/${plan.pdf.length}`, 100 * i / plan.pdf.length);
  const it = Zotero.Items.getByLibraryAndKey(LIB, e.key);
  if (!it || it.deleted) { cnt.gone++; continue; }
  const kids = Zotero.Items.get(it.getAttachments(false)).filter(a => a.isPDFAttachment());
  const cls = [];
  for (const a of kids) cls.push(await classify(a));
  const needs = !cls.includes('published');
  if (needs) {
    cnt.needs++;
    if (cls.length && cls.every(c => c === 'unknown')) cnt.unknownOnly++;
    if (!it.hasTag(TAG)) { it.addTag(TAG); await it.saveTx(); }
    const cr = it.getCreators()[0] || {};
    rows.push({ key: it.key, journal: it.getField('publicationTitle') || it.getField('proceedingsTitle') || '',
      year: (it.getField('date') || '').slice(0, 4), author: cr.lastName || cr.name || '',
      title: it.getField('title'), doi: e.doi, bibcode: e.bibcode, pubPdf: e.pubPdf, cls: cls.join('/') });
  } else {
    cnt.hasPublished++;
    if (it.hasTag(TAG)) { it.removeTag(TAG); await it.saveTx(); }
  }
}
rows.sort((a, b) => a.journal.localeCompare(b.journal) || b.year.localeCompare(a.year) || a.author.localeCompare(b.author));

// CSV
const csv = ['zotero_key,journal,year,first_author,title,doi_url,scix_url,scix_pub_pdf,existing_pdfs']
  .concat(rows.map(r => [r.key, r.journal, r.year, r.author, r.title, 'https://doi.org/' + r.doi,
    'https://scixplorer.org/abs/' + encodeURIComponent(r.bibcode) + '/abstract', r.pubPdf ? 'yes' : 'no', r.cls].map(csvq).join(',')));
await Zotero.File.putContentsAsync(PathUtils.join(DIR, 'needs-pub-pdf.csv'), '﻿' + csv.join('\n'));

// HTML（雑誌別、DOIリンクをクリック → 出版社ページで Zotero Connector で保存）
let html = `<!doctype html><meta charset="utf-8"><title>出版版PDF 未取得リスト</title>
<style>body{font:14px/1.5 -apple-system,sans-serif;margin:24px;max-width:1100px}h2{margin-top:28px;border-bottom:1px solid #ccc}
table{border-collapse:collapse;width:100%}td{padding:3px 6px;border-bottom:1px solid #eee;vertical-align:top}td.y{white-space:nowrap;color:#555}
a{text-decoration:none}a:visited{color:#888}.n{color:#888}</style>
<h1>出版版PDF 未取得リスト（${rows.length}件）</h1>
<p class="n">DOIリンクを開き、出版社ページで Zotero Connector の保存ボタンを押してください（新しいアイテムとして保存されます）。
まとめて保存した後に 6_absorb.js を実行すると、新しいアイテムを既存アイテムに統合し、出版版PDFだけを残して arXiv PDF をゴミ箱に移します。
訪問済みリンクは灰色になります。5_needs_list.js を再実行するとリストが更新されます。</p>`;
let cur = null;
for (const r of rows) {
  if (r.journal !== cur) { if (cur !== null) html += '</table>'; cur = r.journal; html += `<h2>${esc(cur || '(雑誌名なし)')}</h2><table>`; }
  html += `<tr><td class="y">${esc(r.year)}</td><td>${esc(r.author)}</td><td><a href="https://doi.org/${esc(r.doi)}">${esc(r.title)}</a></td>`
        + `<td><a href="https://scixplorer.org/abs/${esc(encodeURIComponent(r.bibcode))}/abstract">SciX</a></td></tr>`;
}
html += '</table>';
await Zotero.File.putContentsAsync(PathUtils.join(DIR, 'needs-pub-pdf.html'), html);

progress('done'); try { pw.startCloseTimer(6000); } catch (e) {}
return `出版版PDFなし=${cnt.needs}（うち判定不能のみ=${cnt.unknownOnly}）, 出版版あり=${cnt.hasPublished}, 対象外=${cnt.gone}\n→ タグ ${TAG} / scix-work/needs-pub-pdf.html, .csv`;
