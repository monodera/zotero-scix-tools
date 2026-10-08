// =====================================================================
// Step 1 (read-only): match every item against NASA SciX by arXiv ID / DOI / bibcode, then by title+author+year. Writes scix-work/resolve.json.
//
// 1_resolve.js  — NASA SciX 照合（読み取り専用：ライブラリは一切変更しません）
//
// 実行方法: Zotero > ツール > 開発者 > Run JavaScript
//           「Run as async function」にチェックを入れ、全文を貼り付けて Run
// 出力:     ~/Zotero/scix-work/resolve.json
// トークン: 下の CFG.token に貼るか、~/Zotero/scix-work/ads_token.txt に1行で保存
// =====================================================================
const CFG = {
  token: '',                 // SciX(ADS) API token（空なら ads_token.txt を読む）
  api: 'https://api.adsabs.harvard.edu/v1/search/query',
  batch: 40,                 // 1リクエストあたりの識別子数
  delayMs: 350,              // リクエスト間隔
  titleSearch: true,         // 識別子で見つからないものをタイトル+著者+年で検索
  limit: 0,                  // 0=全件。テスト時は 30 など
};

const DIR = PathUtils.join(Zotero.DataDirectory.dir, 'scix-work');
await IOUtils.makeDirectory(DIR, { ignoreExisting: true });
let TOKEN = CFG.token.trim();
if (!TOKEN) {
  const tp = PathUtils.join(DIR, 'ads_token.txt');
  if (await IOUtils.exists(tp)) TOKEN = (await Zotero.File.getContentsAsync(tp)).trim();
}
if (!TOKEN) return 'ERROR: APIトークンが未設定です（CFG.token または scix-work/ads_token.txt）';

const win = Zotero.getMainWindow();
const sleep = ms => new Promise(r => win.setTimeout(r, ms));
const FL = 'bibcode,identifier,doi,title,author,year,pubdate,pub,pub_raw,bibstem,volume,issue,page,page_range,doctype,property,esources';
const stats = { requests: 0, errors: [], rateRemaining: null };

// ---------- progress ----------
let pw = null, pline = null;
try {
  pw = new Zotero.ProgressWindow({ closeOnClick: false });
  pw.changeHeadline('SciX resolve');
  pline = new pw.ItemProgress(null, 'starting…');
  pw.show();
} catch (e) { pw = null; }
const progress = (txt, pct) => { try { pline.setText(txt); if (pct != null) pline.setProgress(pct); } catch (e) {} };

// ---------- HTTP ----------
async function ads(params) {
  const url = CFG.api + '?' + new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 5; attempt++) {
    let xhr;
    try {
      xhr = await Zotero.HTTP.request('GET', url, {
        headers: { Authorization: 'Bearer ' + TOKEN },
        responseType: 'text', timeout: 60000, successCodes: false,
      });
    } catch (e) { await sleep(3000 * (attempt + 1)); continue; }
    stats.requests++;
    const rem = xhr.getResponseHeader && xhr.getResponseHeader('X-RateLimit-Remaining');
    if (rem != null) stats.rateRemaining = +rem;
    if (xhr.status === 200) { await sleep(CFG.delayMs); return JSON.parse(xhr.responseText); }
    if (xhr.status === 401 || xhr.status === 403) throw new Error('認証エラー(' + xhr.status + ')：トークンを確認してください');
    if (xhr.status === 429) { progress('rate limited, waiting 60s…'); await sleep(60000); continue; }
    if (xhr.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    stats.errors.push({ status: xhr.status, q: params.q.slice(0, 300), body: (xhr.responseText || '').slice(0, 300) });
    return null;
  }
  stats.errors.push({ status: 'retry-exhausted', q: params.q.slice(0, 300) });
  return null;
}

// ---------- identifier helpers ----------
const AXRE = /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)((?:\d{4}\.\d{4,5})|(?:[a-z][a-z\-]+(?:\.[a-z]{2})?\/\d{7}))/ig;
const normAx = s => s.toLowerCase().replace(/^([a-z\-]+)\.[a-z]{2}\//, '$1/');
const normDoi = s => s.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
// bibcode は19文字ちょうど（& は &amp; / %26、. は %2E になりうる）。直後の句点などを含めない
const BIBRE = /adsabs\.harvard\.edu\/(?:abs|link_gateway)\/([0-9]{4}(?:[A-Za-z0-9.]|&amp;|&|%26|%2[Ee]){15})/g;

function keyOf(idStr) {          // normalize an ADS identifier string into our key space
  const s = idStr.trim();
  let m = s.match(/^arxiv:(.+)$/i); if (m) return 'ax:' + normAx(m[1]);
  m = s.match(/^10\.48550\/arxiv\.(.+)$/i); if (m) return 'ax:' + normAx(m[1]);
  if (/^10\./.test(s)) return 'doi:' + s.toLowerCase();
  if (/^\d{4}\.\d{4,5}$/.test(s) || /^[a-z\-]+\/\d{7}$/i.test(s)) return 'ax:' + normAx(s);
  if (s.length === 19) return 'bib:' + s;
  return null;
}

function itemIds(item) {
  const ids = { ax: new Set(), doi: new Set(), bib: new Set() };
  const f = n => { try { return item.getField(n) || ''; } catch (e) { return ''; } };
  const extra = f('extra'), url = f('url');
  const title = f('title');
  // タイトル自体が「arXiv:1508.04982v1 [astro-ph.GA] …」のように壊れている場合もIDを拾う
  const hay = [f('archiveID'), url, extra, f('DOI'), /^\s*arXiv:/i.test(title) ? title : ''].join(' \n ');
  for (const m of hay.matchAll(AXRE)) ids.ax.add(normAx(m[1]));
  const dois = [f('DOI')];
  for (const m of extra.matchAll(/^\s*DOI:\s*(\S+)/gim)) dois.push(m[1]);
  for (let d of dois) {
    d = normDoi(d || '');
    if (!d) continue;
    if (d.startsWith('10.48550/arxiv.')) { ids.ax.add(normAx(d.slice(15))); continue; }
    if (/^10\.\d{4,9}\//.test(d)) ids.doi.add(d);
  }
  for (const m of (url + ' ' + extra).matchAll(BIBRE)) ids.bib.add(decodeURIComponent(m[1].replace(/&amp;/g, '&')));
  for (const m of extra.matchAll(/^\s*(?:ADS |SciX )?Bibcode:\s*(\S{19})/gim)) ids.bib.add(m[1]);
  return { ax: [...ids.ax], doi: [...ids.doi], bib: [...ids.bib] };
}

// ---------- collect items ----------
progress('loading items…');
const LIB = Zotero.Libraries.userLibraryID;
let items = (await Zotero.Items.getAll(LIB, true, false)).filter(i => i.isRegularItem());
try { await Zotero.Items.loadDataTypes(items); } catch (e) {}
if (CFG.limit) items = items.slice(0, CFG.limit);

const snap = {};
for (const it of items) {
  const f = n => { try { return it.getField(n) || ''; } catch (e) { return ''; } };
  const cr = it.getCreators();
  const fa = cr.length ? (cr[0].lastName || cr[0].name || '') : '';
  const atts = Zotero.Items.get(it.getAttachments(false)).map(a => ({
    id: a.id, key: a.key, linkMode: a.attachmentLinkMode, contentType: a.attachmentContentType,
    url: a.getField('url'), title: a.getField('title'), path: a.attachmentPath,
  }));
  const notes = Zotero.Items.get(it.getNotes(false));
  snap[it.key] = {
    id: it.id, key: it.key, type: it.itemType, title: f('title'), date: f('date'),
    year: parseInt((Zotero.Date.strToDate(f('date')) || {}).year) || null,
    firstAuthor: fa, nAuthors: cr.length, DOI: f('DOI'), url: f('url'), extra: f('extra'),
    libraryCatalog: f('libraryCatalog'), publicationTitle: f('publicationTitle'),
    volume: f('volume'), issue: f('issue'), pages: f('pages'),
    dateAdded: it.dateAdded, ids: itemIds(it), atts,
    nNotes: notes.length, adsNotes: notes.filter(n => /adsabs/i.test(n.getNote())).map(n => n.key),
    collections: it.getCollections().length, nTags: it.getTags().length,
  };
}
// standalone notes containing ADS links
const allNotes = (await Zotero.Items.getAll(LIB, true, false)).filter(i => i.isNote() && /adsabs/i.test(i.getNote()));
// ADS リンクを含むノート本文（ADS→SciX 置換の計画用）
const adsNoteBodies = {};
for (const s of Object.values(snap)) for (const nk of s.adsNotes) { const n = Zotero.Items.getByLibraryAndKey(LIB, nk); if (n) adsNoteBodies[nk] = n.getNote(); }
for (const n of allNotes) adsNoteBodies[n.key] = n.getNote();

// ---------- phase 1: identifier batch queries ----------
const docsByKey = {};   // our key -> [bibcode]
const docs = {};        // bibcode -> doc
function indexDoc(d) {
  docs[d.bibcode] = d;
  const keys = new Set(['bib:' + d.bibcode]);
  for (const s of (d.identifier || [])) { const k = keyOf(s); if (k) keys.add(k); }
  for (const s of (d.doi || [])) { const k = keyOf(s); if (k) keys.add(k); }
  for (const k of keys) { (docsByKey[k] = docsByKey[k] || new Set()).add(d.bibcode); }
}
const terms = [];
for (const s of Object.values(snap)) {
  for (const a of s.ids.ax) terms.push('arXiv:' + a);
  for (const d of s.ids.doi) terms.push(d);
  for (const b of s.ids.bib) terms.push(b);
}
const uterms = [...new Set(terms)];
const q = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
for (let i = 0; i < uterms.length; i += CFG.batch) {
  const chunk = uterms.slice(i, i + CFG.batch);
  progress(`identifier query ${i}/${uterms.length}`, 100 * i / uterms.length);
  const r = await ads({ q: 'identifier:(' + chunk.map(q).join(' OR ') + ')', fl: FL, rows: 200 });
  if (r && r.response) r.response.docs.forEach(indexDoc);
}

// ---------- match ----------
const out = {};
const prio = ['bib', 'doi', 'ax'];
for (const s of Object.values(snap)) {
  const hits = {};
  for (const t of prio) for (const v of s.ids[t]) {
    const set = docsByKey[t + ':' + (t === 'bib' ? v : v.toLowerCase())];
    if (set) for (const b of set) (hits[b] = hits[b] || []).push(t);
  }
  out[s.key] = { hits };
}

// ---------- phase 2: title search for unmatched ----------
const STOP = new Set('the of and a an in on for with from to at by as its is are be or via using new'.split(' '));
function titleWords(t) {
  t = t.replace(/<[^>]+>/g, ' ').replace(/\$[^$]*\$/g, ' ').replace(/\\[a-zA-Z]+/g, ' ')
       .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // 全大文字語はSciXで略語扱い(大文字小文字区別)になるため小文字化
  return t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).slice(0, 12);
}
if (CFG.titleSearch) {
  const todo = Object.values(snap).filter(s => !Object.keys(out[s.key].hits).length && s.type !== 'webpage' && s.title);
  let n = 0;
  for (const s of todo) {
    n++;
    progress(`title search ${n}/${todo.length}`, 100 * n / todo.length);
    const w = titleWords(s.title);
    if (w.length < 2) continue;
    const base = 'title:(' + w.join(' ') + ')' + (s.year ? ` year:${s.year - 1}-${s.year + 1}` : '');
    const au = s.firstAuthor ? ` author:${q('^' + s.firstAuthor)}` : '';
    let r = await ads({ q: base + au, fl: FL, rows: 5, sort: 'score desc' });
    let docsR = (r && r.response && r.response.docs) || [];
    if (!docsR.length && au) {
      r = await ads({ q: base, fl: FL, rows: 5, sort: 'score desc' });
      docsR = (r && r.response && r.response.docs) || [];
    }
    docsR.forEach(d => { docs[d.bibcode] = docs[d.bibcode] || d; });
    out[s.key].titleCands = docsR.map(d => d.bibcode);
  }
}

// ---------- write ----------
const result = {
  generated: new Date().toISOString(), zoteroVersion: Zotero.version, cfg: { ...CFG, token: undefined },
  stats, snap, out, docs, adsStandaloneNotes: allNotes.map(n => n.key), adsNoteBodies,
};
const outPath = PathUtils.join(DIR, 'resolve.json');
await Zotero.File.putContentsAsync(outPath, JSON.stringify(result));
const nHit = Object.values(out).filter(o => Object.keys(o.hits).length).length;
const nCand = Object.values(out).filter(o => o.titleCands && o.titleCands.length).length;
const msg = `完了: items=${items.length}, 識別子一致=${nHit}, タイトル候補あり=${nCand}, requests=${stats.requests}, errors=${stats.errors.length}, rateRemaining=${stats.rateRemaining}\n→ ${outPath}`;
progress('done'); try { pw.startCloseTimer(8000); } catch (e) {}
return msg;
