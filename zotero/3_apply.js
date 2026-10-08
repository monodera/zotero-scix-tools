// =====================================================================
// Step 4: apply scix-work/plan.json (merge duplicates, update to published metadata, add SciX/Publisher links, replace ADS links). Dry-run first; resumable; makes a DB backup on the first real run.
//
// 3_apply.js — 計画ファイル(plan.json)をライブラリに適用
//   ・重複マージ / 出版版メタデータへの更新 / SciX・Publisher リンク追加
//   ・ADS URL → SciX URL 置換
//
// 実行方法: Zotero > ツール > 開発者 > Run JavaScript（Run as async function にチェック）
// 入力:     ~/Zotero/scix-work/plan.json
// ログ:     ~/Zotero/scix-work/apply-log.jsonl（実行済みopは再実行時にスキップ＝途中再開可）
//
// 推奨手順: dryRun:true で一度実行 → dryRun:false, limit:20 → 結果を確認 → limit:0 で全件
// =====================================================================
const CFG = {
  dryRun: true,      // true: 何も変更せず検証だけ行い dryrun-report.json を出力
  limit: 0,          // 0=全件。テスト時は 20 など（未実行opの先頭から）
  only: null,        // 例: ['merge'] で op 種別を限定。null=全種別
};

const DIR = PathUtils.join(Zotero.DataDirectory.dir, 'scix-work');
const LIB = Zotero.Libraries.userLibraryID;
const plan = JSON.parse(await Zotero.File.getContentsAsync(PathUtils.join(DIR, 'plan.json')));
const LOG = PathUtils.join(DIR, 'apply-log.jsonl');

const done = new Set();
if (await IOUtils.exists(LOG)) {
  for (const line of (await Zotero.File.getContentsAsync(LOG)).split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.status === 'ok' || r.status === 'noop') done.add(r.op); } catch (e) {}
  }
}
async function log(rec) {
  rec.t = new Date().toISOString();
  if (CFG.dryRun) { report.push(rec); return; }
  const line = JSON.stringify(rec) + '\n';
  try { await IOUtils.writeUTF8(LOG, line, { mode: 'appendOrCreate' }); }
  catch (e) {
    const prev = (await IOUtils.exists(LOG)) ? await Zotero.File.getContentsAsync(LOG) : '';
    await Zotero.File.putContentsAsync(LOG, prev + line);
  }
}
const report = [];

// ---------- 自動バックアップ（初回の本実行時のみ。VACUUM INTO で整合性のあるコピーを作成） ----------
async function backupDB(tag) {
  const bdir = PathUtils.join(DIR, 'backup');
  await IOUtils.makeDirectory(bdir, { ignoreExisting: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const dst = PathUtils.join(bdir, `zotero.sqlite.${tag}-${stamp}`);
  try { await Zotero.DB.queryAsync('VACUUM INTO ?', [dst]); }
  catch (e) {
    try { await Zotero.DB.queryAsync('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e2) {}
    await IOUtils.copy(PathUtils.join(Zotero.DataDirectory.dir, 'zotero.sqlite'), dst);
  }
  if (!(await IOUtils.exists(dst))) throw new Error('バックアップ作成に失敗しました: ' + dst);
  return dst;
}

let BACKUP = null;
if (!CFG.dryRun && !(await IOUtils.exists(LOG))) BACKUP = await backupDB('pre-apply');


let pw = null, pline = null;
try { pw = new Zotero.ProgressWindow({ closeOnClick: false }); pw.changeHeadline('SciX apply' + (CFG.dryRun ? ' (dry-run)' : '')); pline = new pw.ItemProgress(null, 'starting…'); pw.show(); } catch (e) {}
const progress = (t, p) => { try { pline.setText(t); if (p != null) pline.setProgress(p); } catch (e) {} };

const get = key => Zotero.Items.getByLibraryAndKey(LIB, key) || null;
const alive = it => it && !it.deleted;
const LINKED_URL = Zotero.Attachments.LINK_MODE_LINKED_URL;

// replaceSameKey=true : "Key: value" 形式の行は同じKeyの行を置き換える（update用）
// replaceSameKey=false: 完全一致しない行だけ追記（merge用）
function extraWith(extra, lines, replaceSameKey = true) {
  const s = (extra || '').replace(/\s+$/, '');
  const have = s ? s.split('\n') : [];
  for (const ln of lines || []) {
    if (!ln.trim() || have.includes(ln)) continue;
    const k = ln.split(':')[0].trim().toLowerCase();
    if (k === 'arxiv' && have.some(h => /^arxiv\s*:/i.test(h.trim()))) continue;  // 既存のarXiv行は保持
    const idx = replaceSameKey && /^[A-Za-z][\w .-]{0,30}:/.test(ln)
      ? have.findIndex(h => h.split(':')[0].trim().toLowerCase() === k) : -1;
    if (idx >= 0) have[idx] = ln; else have.push(ln);
  }
  return have.join('\n');
}

// ---------------- op handlers ----------------
const H = {
  async merge(op) {
    const master = get(op.master);
    const others = op.others.map(get).filter(alive);
    if (!alive(master)) return { status: 'skip', why: 'master missing/trashed' };
    if (!others.length) return { status: 'noop', why: 'others already merged/trashed' };
    if (CFG.dryRun) return { status: 'ok', why: `would merge ${others.length} into ${master.getField('title').slice(0, 60)}` };
    // master の空欄を他アイテムで補完（Extra は行単位で統合）
    for (const o of others) {
      for (const fname of o.getUsedFields(true)) {
        if (fname === 'extra') continue;
        const fid = Zotero.ItemFields.getID(fname);
        if (!Zotero.ItemFields.isValidForType(fid, master.itemTypeID)) continue;
        if (!master.getField(fname) && o.getField(fname)) master.setField(fname, o.getField(fname));
      }
      if (o.getField('extra')) master.setField('extra', extraWith(master.getField('extra'), o.getField('extra').split('\n'), false));
      if (!master.numCreators() && o.numCreators()) master.setCreators(o.getCreators());
    }
    if (master.hasChanged()) await master.saveTx();
    await Zotero.Items.merge(master, others);
    return { status: 'ok' };
  },

  async update(op) {
    const it = get(op.key);
    if (!alive(it)) return { status: 'skip', why: 'item missing/trashed' };
    const changes = [];
    if (op.setType && it.itemType !== op.setType) {
      changes.push(`type ${it.itemType}->${op.setType}`);
      if (!CFG.dryRun) it.setType(Zotero.ItemTypes.getID(op.setType));
    }
    const typeID = op.setType ? Zotero.ItemTypes.getID(op.setType) : it.itemTypeID;
    for (const [f, v] of Object.entries(op.fields || {})) {
      if (v == null || v === '') continue;
      const fid = Zotero.ItemFields.getID(f);
      if (!fid || !Zotero.ItemFields.isValidForType(fid, typeID)) { changes.push(`!invalid field ${f}`); continue; }
      const cur = CFG.dryRun && op.setType ? '' : it.getField(f);
      if (cur !== String(v)) { changes.push(`${f}: "${String(cur).slice(0, 40)}" -> "${String(v).slice(0, 40)}"`); if (!CFG.dryRun) it.setField(f, String(v)); }
    }
    if (op.extraLines && op.extraLines.length) {
      const nx = extraWith(it.getField('extra'), op.extraLines);
      if (nx !== it.getField('extra')) { changes.push('extra'); if (!CFG.dryRun) it.setField('extra', nx); }
    }
    for (const t of op.tags || []) if (!it.hasTag(t)) { changes.push('tag ' + t); if (!CFG.dryRun) it.addTag(t); }
    if (!changes.length) return { status: 'noop' };
    if (!CFG.dryRun) await it.saveTx();
    return { status: 'ok', changes };
  },

  async link(op) {
    const it = get(op.key);
    if (!alive(it)) return { status: 'skip', why: 'item missing/trashed' };
    const kids = Zotero.Items.get(it.getAttachments(false)).filter(a => a.attachmentLinkMode === LINKED_URL);
    if (kids.some(a => a.getField('url') === op.url)) return { status: 'noop' };
    const same = kids.find(a => a.getField('title') === op.title);
    if (same) {
      if (!CFG.dryRun) { same.setField('url', op.url); await same.saveTx(); }
      return { status: 'ok', why: 'updated existing link' };
    }
    // 既存の ADS リンク（op.adopt）があれば、新しく足さずにそれを書き換える
    const ads = op.adopt && kids.find(a => a.key === op.adopt && /adsabs/i.test(a.getField('url')));
    if (ads) {
      if (!CFG.dryRun) { ads.setField('url', op.url); ads.setField('title', op.title); await ads.saveTx(); }
      return { status: 'ok', why: 'converted ADS link' };
    }
    if (!CFG.dryRun) await Zotero.Attachments.linkFromURL({ url: op.url, parentItemID: it.id, title: op.title });
    return { status: 'ok' };
  },

  async setUrl(op) {           // item / attachment の URL フィールド置換（現在値が from と一致する時のみ）
    const it = get(op.key);
    if (!alive(it)) return { status: 'skip', why: 'missing/trashed' };
    const cur = it.getField('url');
    if (cur === op.to) return { status: 'noop' };
    if (cur !== op.from) return { status: 'skip', why: 'url changed since planning: ' + cur };
    if (!CFG.dryRun) { it.setField('url', op.to); await it.saveTx(); }
    return { status: 'ok' };
  },

  async noteReplace(op) {
    const n = get(op.key);
    if (!alive(n) || !n.isNote()) return { status: 'skip', why: 'note missing' };
    const html = n.getNote();
    let nh = html;
    for (const [from, to] of op.pairs) nh = nh.split(from).join(to);
    if (nh === html) return { status: 'noop' };
    if (!CFG.dryRun) { n.setNote(nh); await n.saveTx(); }
    return { status: 'ok' };
  },
};

// ---------------- run ----------------
let ops = plan.ops.filter(o => !done.has(o.id) && (!CFG.only || CFG.only.includes(o.op)));
if (CFG.limit) ops = ops.slice(0, CFG.limit);
const cnt = {};
for (let i = 0; i < ops.length; i++) {
  const op = ops[i];
  progress(`${op.op} ${i + 1}/${ops.length}`, 100 * (i + 1) / ops.length);
  let res;
  try { res = await H[op.op](op); }
  catch (e) {
    res = { status: 'error', why: String(e && e.message || e) };
    // 保存に失敗したアイテムの未保存の変更を破棄（後続の保存に混入しないように）
    try { const it = get(op.key || op.master); if (it && it.hasChanged && it.hasChanged()) await it.reload(null, true); } catch (e2) {}
  }
  const k = op.op + ':' + res.status; cnt[k] = (cnt[k] || 0) + 1;
  await log({ op: op.id, kind: op.op, key: op.key || op.master, ...res });
}
if (CFG.dryRun) await Zotero.File.putContentsAsync(PathUtils.join(DIR, 'dryrun-report.json'), JSON.stringify(report, null, 1));
progress('done'); try { pw.startCloseTimer(8000); } catch (e) {}
return (BACKUP ? `backup: ${BACKUP}\n` : '') + (CFG.dryRun ? '[DRY-RUN] ' : '') + `処理 ${ops.length} ops（実行済みスキップ ${done.size}）\n` + JSON.stringify(cnt, null, 1);
