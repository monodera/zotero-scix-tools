// =====================================================================
// Step 2 (read-only): run the extra SciX queries listed in scix-work/queries.json (made by python/make_queries.py). Writes scix-work/query-results.json. Resumable.
//
// 2_query.js — 追加照合（読み取り専用：ライブラリは変更しません）
//   queries.json に用意した検索を SciX に投げ、結果を query-results.json に保存します。
//   ・識別子もタイトルでも見つからなかったアイテムの再検索（条件を緩めたもの）
//   ・arXiv版しか見つからなかったアイテムについて、出版版が別レコードになっていないかの確認
//
// 実行方法: 1_resolve.js と同じ（Run JavaScript / Run as async function にチェック）
// =====================================================================
const CFG = { token: '', api: 'https://api.adsabs.harvard.edu/v1/search/query', delayMs: 350 };

const DIR = PathUtils.join(Zotero.DataDirectory.dir, 'scix-work');
let TOKEN = CFG.token.trim();
if (!TOKEN) TOKEN = (await Zotero.File.getContentsAsync(PathUtils.join(DIR, 'ads_token.txt'))).trim();
const input = JSON.parse(await Zotero.File.getContentsAsync(PathUtils.join(DIR, 'queries.json')));
const OUT = PathUtils.join(DIR, 'query-results.json');
const win = Zotero.getMainWindow();
const sleep = ms => new Promise(r => win.setTimeout(r, ms));

// 途中再開：既存結果があれば読み込んで未実行分とエラー（null）だけ実行
let results = {}, badNote = '';
if (await IOUtils.exists(OUT)) {
  try { results = JSON.parse(await Zotero.File.getContentsAsync(OUT)).results || {}; }
  catch (e) {   // 読めないファイルを上書きして失わないよう、退避してから最初から実行する
    const bad = OUT + '.bad-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    await IOUtils.move(OUT, bad);
    badNote = `既存の query-results.json が読めなかったので ${bad} に退避し、最初から実行しました。\n`;
  }
}

let pw = null, pline = null;
try { pw = new Zotero.ProgressWindow({ closeOnClick: false }); pw.changeHeadline('SciX query'); pline = new pw.ItemProgress(null, 'starting…'); pw.show(); } catch (e) {}
const progress = (t, p) => { try { pline.setText(t); if (p != null) pline.setProgress(p); } catch (e) {} };

const stats = { requests: 0, errors: [], rateRemaining: null, rateReset: null, dailyLimit: false };
async function ads(params, id) {
  let n429 = 0;
  const url = CFG.api + '?' + new URLSearchParams(params).toString();
  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    let xhr;
    try {
      xhr = await Zotero.HTTP.request('GET', url, { headers: { Authorization: 'Bearer ' + TOKEN }, responseType: 'text', timeout: 60000, successCodes: false });
    } catch (e) { lastErr = String(e && e.message || e); await sleep(3000 * (attempt + 1)); continue; }
    stats.requests++;
    const rem = xhr.getResponseHeader && xhr.getResponseHeader('X-RateLimit-Remaining');
    if (rem != null) stats.rateRemaining = +rem;
    const reset = xhr.getResponseHeader && xhr.getResponseHeader('X-RateLimit-Reset');
    if (reset != null) stats.rateReset = +reset;
    if (xhr.status === 200) { await sleep(CFG.delayMs); return JSON.parse(xhr.responseText); }
    if (xhr.status === 401 || xhr.status === 403) throw new Error('認証エラー(' + xhr.status + ')');
    if (xhr.status === 429) {
      // 1日の上限を使い切った場合は待っても回復しないので打ち切る（残り回数のヘッダーがない場合に備え、429 が続いたときも）
      if (stats.rateRemaining === 0 || ++n429 >= 5) { stats.dailyLimit = true; return null; }
      progress('rate limited, waiting 60s…'); await sleep(60000); continue;
    }
    if (xhr.status >= 500) { lastErr = 'HTTP ' + xhr.status; await sleep(5000 * (attempt + 1)); continue; }
    // 4xx はクエリ自体の問題なので、再実行しても同じ結果になる可能性が高い
    stats.errors.push({ id, status: xhr.status, q: params.q.slice(0, 300), body: (xhr.responseText || '').slice(0, 300) });
    return null;
  }
  stats.errors.push({ id, status: 'retry-exhausted', q: params.q.slice(0, 300), last: lastErr });
  return null;
}

// null（エラー）と未設定（日次上限で中断）のクエリは再実行時に再試行する。0件ヒットは [] で保存される
const todo = input.queries.filter(q => results[q.id] == null);
try {
  for (let i = 0; i < todo.length; i++) {
    const q = todo[i];
    progress(`query ${i + 1}/${todo.length}`, 100 * (i + 1) / todo.length);
    const r = await ads({ q: q.q, fl: input.fl, rows: q.rows || 5, sort: 'score desc' }, q.id);
    if (stats.dailyLimit) break;
    results[q.id] = r && r.response ? r.response.docs : null;
    if (i % 100 === 99) await Zotero.File.putContentsAsync(OUT, JSON.stringify({ results }));
  }
} finally {   // 認証エラーなどで中断しても、それまでの結果は保存する
  await Zotero.File.putContentsAsync(OUT, JSON.stringify({ generated: new Date().toISOString(), stats, results }));
}
progress('done'); try { pw.startCloseTimer(8000); } catch (e) {}
const left = input.queries.filter(q => results[q.id] == null).length;
const n4xx = new Set(stats.errors.filter(e => typeof e.status === 'number').map(e => e.id)).size;
const resetAt = stats.rateReset ? new Date(stats.rateReset * 1000).toLocaleString() : '不明';
return badNote + (stats.dailyLimit ? `1日のリクエスト上限に達したので中断しました（リセット: ${resetAt}）。リセット後に再実行すると続きから実行します。\n` : '')
  + `queries=${todo.length}, requests=${stats.requests}, errors=${stats.errors.length}, 未取得（再実行で再試行）=${left}, rateRemaining=${stats.rateRemaining}\n`
  + (n4xx ? `うち ${n4xx} 件は 4xx エラー（クエリ自体の問題で、再実行しても失敗する可能性が高い）。詳細は query-results.json の stats.errors\n` : '')
  + `→ ${OUT}`;
