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
if (!TOKEN) {
  const tp = PathUtils.join(DIR, 'ads_token.txt');
  if (await IOUtils.exists(tp)) TOKEN = (await Zotero.File.getContentsAsync(tp)).trim();
}
if (!TOKEN) return 'ERROR: APIトークンが未設定です（CFG.token または scix-work/ads_token.txt）';
const input = JSON.parse(await Zotero.File.getContentsAsync(PathUtils.join(DIR, 'queries.json')));
const OUT = PathUtils.join(DIR, 'query-results.json');
const win = Zotero.getMainWindow();
const sleep = ms => new Promise(r => win.setTimeout(r, ms));

// 既存の結果を読み込む。fetchedIn: 各クエリの結果をどの queries.json（作成日時）で取得したか
let results = {}, fetchedIn = {}, badNote = '';
if (await IOUtils.exists(OUT)) {
  try { const j = JSON.parse(await Zotero.File.getContentsAsync(OUT)); results = j.results || {}; fetchedIn = j.fetchedIn || {}; }
  catch (e) {   // 読めないファイルを上書きして失わないよう、退避してから最初から実行する
    const bad = OUT + '.bad-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    await IOUtils.move(OUT, bad);
    badNote = `既存の query-results.json が読めなかったので ${bad} に退避し、最初から実行しました。\n`;
  }
}

let pw = null, pline = null;
try { pw = new Zotero.ProgressWindow({ closeOnClick: false }); pw.changeHeadline('SciX query'); pline = new pw.ItemProgress(null, 'starting…'); pw.show(); } catch (e) {}
const progress = (t, p) => { try { pline.setText(t); if (p != null) pline.setProgress(p); } catch (e) {} };

const stats = { requests: 0, errors: [], rateRemaining: null, rateReset: null, dailyLimit: false, offline: '' };
async function ads(params, id) {
  let n429 = 0, nNet = 0;
  const url = CFG.api + '?' + new URLSearchParams(params).toString();
  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    let xhr;
    try {
      xhr = await Zotero.HTTP.request('GET', url, { headers: { Authorization: 'Bearer ' + TOKEN }, responseType: 'text', timeout: 60000, successCodes: false });
    } catch (e) { nNet++; lastErr = String(e && e.message || e); await sleep(3000 * (attempt + 1)); continue; }
    // successCodes: false だと、DNS 失敗・接続拒否・オフラインなどの通信エラーは例外ではなく status 0 で返る
    if (!xhr.status) {
      nNet++; lastErr = 'network error (status 0' + (xhr.channel ? ', ' + xhr.channel.status : '') + ')';
      await sleep(3000 * (attempt + 1)); continue;
    }
    stats.requests++;
    const rem = xhr.getResponseHeader && xhr.getResponseHeader('X-RateLimit-Remaining');
    if (rem != null) stats.rateRemaining = +rem;
    const reset = xhr.getResponseHeader && xhr.getResponseHeader('X-RateLimit-Reset');
    if (reset != null) stats.rateReset = +reset;
    if (xhr.status === 200) {
      await sleep(CFG.delayMs);
      try { const j = JSON.parse(xhr.responseText); if (j && j.response) return j; } catch (e) {}
      // 200 なのに検索結果の JSON ではない（メンテナンス中の HTML ページなど）。一時的な問題として再試行する
      lastErr = 'HTTP 200 but not a search result: ' + (xhr.responseText || '').slice(0, 200);
      await sleep(5000 * (attempt + 1)); continue;
    }
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
  // 通信自体が一度も成功しないなら、ネットワーク障害とみなして打ち切る（以降のクエリも同じく失敗するので）
  if (nNet >= 5) { stats.offline = lastErr || 'unknown'; return null; }
  stats.errors.push({ id, status: 'retry-exhausted', q: params.q.slice(0, 300), last: lastErr });
  return null;
}

// 同じ queries.json での途中再開なら、null（エラー）と未設定（日次上限などで中断）のクエリだけを実行する。
// make_queries.py で queries.json を作り直した（定期的に回し直す）場合は、前回の結果（0件の [] も）を使い回さない
// よう、そこにあるクエリをすべて実行し直す。今の queries.json にないクエリの結果は残す（round 2 で round 1 の分）
const batch = input.generated || null;
const pending = q => results[q.id] == null || (batch && fetchedIn[q.id] !== batch);
const todo = input.queries.filter(pending);
let runErr = null, saveErr = null;
try {
  for (let i = 0; i < todo.length; i++) {
    const q = todo[i];
    progress(`query ${i + 1}/${todo.length}`, 100 * (i + 1) / todo.length);
    const r = await ads({ q: q.q, fl: input.fl, rows: q.rows || 5, sort: 'score desc' }, q.id);
    if (stats.dailyLimit || stats.offline) break;
    results[q.id] = r && r.response ? r.response.docs : null;
    if (batch) fetchedIn[q.id] = batch;
    if (i % 100 === 99) await Zotero.File.putContentsAsync(OUT, JSON.stringify({ results, fetchedIn }));
  }
} catch (e) { runErr = e; }
// 認証エラーなどで中断しても、それまでの結果は保存する。保存の失敗で元のエラーが隠れないよう、両方を報告する
try { await Zotero.File.putContentsAsync(OUT, JSON.stringify({ generated: new Date().toISOString(), stats, results, fetchedIn })); }
catch (e) { saveErr = e; }
progress('done'); try { pw.startCloseTimer(8000); } catch (e) {}
if (runErr || saveErr) {
  const msg = e => String(e && e.message || e);
  throw new Error(badNote + [runErr && msg(runErr), saveErr && `query-results.json の保存に失敗しました: ${msg(saveErr)}`].filter(Boolean).join(' / '));
}
const left = input.queries.filter(pending).length;
const n4xx = new Set(stats.errors.filter(e => e.status >= 400 && e.status < 500).map(e => e.id)).size;
const resetAt = stats.rateReset ? new Date(stats.rateReset * 1000).toLocaleString() : '不明';
return badNote
  + (stats.offline ? `ネットワークに接続できないので中断しました（最後のエラー: ${stats.offline}）。接続を確認してから再実行すると続きから実行します。\n` : '')
  + (stats.dailyLimit ? `1日のリクエスト上限に達したので中断しました（リセット: ${resetAt}）。リセット後に再実行すると続きから実行します。\n` : '')
  + `queries=${todo.length}, requests=${stats.requests}, errors=${stats.errors.length}, 未取得（再実行で再試行）=${left}, rateRemaining=${stats.rateRemaining}\n`
  + (n4xx ? `うち ${n4xx} 件は 4xx エラー（クエリ自体の問題で、再実行しても失敗する可能性が高い）。詳細は query-results.json の stats.errors\n` : '')
  + `→ ${OUT}`;
