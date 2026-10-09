# zotero-scix-tools

天文学の論文を Zotero で管理している人向けに、ライブラリを [NASA Science Explorer (SciX)](https://scixplorer.org/) と照合して整理するスクリプト集です。

[English README](README.md)

## できること

- **重複のマージ**：arXiv ID・DOI・SciX bibcode が一致するもの（arXiv 版と出版版の組を含む）を自動でマージします。タイトルが大きく異なる場合は、第一著者も一致し、arXiv ID を共有しているか識別子で同じ SciX レコードに一致するときだけマージし、それ以外は確認リストに出します。タイトルが似ているだけのものはマージせず、確認リストに出します。
- **出版版への更新**：arXiv 論文が出版済みなら、アイテムタイプを Journal Article / Conference Paper に変え、雑誌名・巻・号・ページ・出版日・DOI・タイトルを出版版に合わせます。arXiv ID は Extra 欄に残します。
- **リンクの追加**：各アイテムに「NASA SciX」と「Publisher」（doi.org）のリンク添付を付けます。
- **ADS から SciX への置き換え**：URL 欄・添付の URL・ノート中の ADS リンクを SciX のものに置き換えます。
- **arXiv 版 PDF の整理**：出版版 PDF がすでにある場合、arXiv 版 PDF をゴミ箱に移します。PDF に書き込みのあるものは残します。
- **出版版 PDF の手動取得の補助**：未取得の論文をリスト（HTML/CSV）にします。Zotero Connector で保存したあと、既存アイテムに統合できます。

SciX で見つからない論文は、DOI があれば出版社のリンクを付けます。どちらもないものは確認リストに出します。

## 方針

- **すべて Zotero の中で動きます。** スクリプトは Zotero の「Run JavaScript」で実行します。Zotero を終了する必要はありません。変更は通常の編集と同じ扱いなので、Zotero の同期にもそのまま乗ります。
- **計画を作ってから適用します。** 照合（読み取りのみ）→ 計画の作成（Python）→ 人の目で確認 → 適用、の順に進みます。適用には dry-run があり、途中で止まっても続きから再開できます。本実行のたびに、その直前にデータベースのバックアップを自動で作ります。
- **出版版 PDF は自動ではダウンロードしません。** 大手の出版社（IOP/AAS、OUP、EDP など）は、自動アクセスをボット判定ではじきます。これを回避することは購読契約にも反し、所属機関全体のアクセスが止められる恐れがあります。PDF の取得は、人がブラウザで Zotero Connector を使って行う前提にしています。まとめて取得したい場合は、図書館を通じて出版社の TDM（テキスト・データマイニング）提供を相談してください。

## 必要なもの

- Zotero 7 以降（10.0.6 で動作確認）
- SciX の API トークン（scixplorer.org にログイン → Settings → API Token。ADS と共通です）
- Python 3.8 以降（標準ライブラリのみで動きます）

## ファイル構成

```
zotero/                 Zotero の Run JavaScript に貼り付けて実行するスクリプト
  1_resolve.js          SciX と照合（読み取りのみ）            → scix-work/resolve.json
  2_query.js            追加の SciX 検索（読み取りのみ）       → scix-work/query-results.json
  3_apply.js            計画を適用（マージ・更新・リンク・ADS 置換）
  4_trash_arxiv_pdf.js  出版版 PDF があるアイテムの arXiv 版 PDF をゴミ箱へ
  5_needs_list.js       出版版 PDF 未取得のリスト作成とタグ付け
  6_absorb.js           Connector で保存した出版版を既存アイテムに統合
python/
  make_queries.py       追加検索のクエリを作る                 → scix-work/queries.json
  build_plan.py         計画と確認リストを作る                 → scix-work/plan.json, review.html
examples/manual.example.json   手動で対応を指定するファイルの例
```

作業ファイルは、Zotero のデータディレクトリの中の `scix-work/`（通常は `~/Zotero/scix-work/`）に置かれます。

## 手順

### 0. 準備

1. Zotero → 設定 → 詳細 → ファイルとフォルダ で、データディレクトリの場所を確認します（以下、`~/Zotero` とします）。
2. 念のため、Zotero を終了して `~/Zotero/zotero.sqlite` をコピーしておきます。
3. 作業ディレクトリを作り、API トークンを保存します。
   ```bash
   mkdir -p ~/Zotero/scix-work
   printf '%s' 'YOUR_SCIX_TOKEN' > ~/Zotero/scix-work/ads_token.txt
   ```

スクリプトの実行方法は、どれも共通です。Zotero → ツール → 開発者 → **Run JavaScript** を開き、**「Run as async function」にチェック**を入れます。スクリプトの全文を貼り付けて（macOS なら `pbcopy < zotero/1_resolve.js` → ⌘V）、Run を押します。設定は各スクリプトの冒頭にある `CFG` で変えられます。

### 1. 照合（読み取りのみ）

1. `1_resolve.js` を実行します。まず `limit: 30` で試し、問題なければ `limit: 0` で全件を処理します。7,000 件でおよそ 1,200 リクエスト、20〜30 分かかります。
2. 追加検索のクエリを作ります。
   ```bash
   cd python
   python3 make_queries.py
   ```
3. `2_query.js` を実行します。

### 2. 計画の作成と確認

```bash
python3 build_plan.py
```

`~/Zotero/scix-work/review.html` を開いて確認します。アイテムキーをクリックすると、Zotero でそのアイテムが開きます。

- まだ見つからないものが多ければ、`python3 make_queries.py --round 2` → `2_query.js` → `build_plan.py` をもう一度回します。年を条件から外して検索し直し、追加検索で arXiv 版にだけ一致したアイテムについては出版版を探します。
- 対応付けを直したいとき、マージしたくない組があるとき、手で調べたリンクを付けたいときは、`examples/manual.example.json` を参考に `scix-work/manual.json` を書いて、`build_plan.py` を再実行します。`fields` に書いた値は、アイテムの既存の値や SciX 由来の値より優先して設定されます。ただし `3_apply.js` は `apply-log.jsonl` に記録済みの操作を再実行しないので、一度更新したアイテムに後から `fields` を追加しても反映されません。その場合は Zotero 上で直接修正してください。

### 3. 適用

`3_apply.js` を次の順に実行します。

1. `dryRun: true` で実行し、件数を確認します（変更はしません。詳細は `dryrun-report.json` に出ます）。
2. `dryRun: false, limit: 5, only: ['merge']` で実行し、Zotero 上でマージの結果を確認します。未適用の操作がある本実行のたびに、`scix-work/backup/` にデータベースのバックアップが作られます。古いバックアップは自動では消えないので、不要になったものは手で削除してください（最初の本実行の前に作られたいちばん古いものは、やり直す可能性がなくなるまで残しておくのが安全です）。
3. `limit: 0, only: null` で全件を実行します。実行済みの操作はスキップされます（`apply-log.jsonl`）。

更新したアイテムには `_scix:published-update` タグが付きます。確認が済んだら、タグごと一括で削除できます。

### 4. PDF の整理

1. `4_trash_arxiv_pdf.js`：まず dry-run、問題なければ `dryRun: false` で実行します。出版版 PDF と arXiv 版 PDF が両方あるアイテムから、arXiv 版をゴミ箱に移します。
2. `5_needs_list.js`：出版版 PDF がないアイテムに `_scix:needs-pub-pdf` タグを付け、`needs-pub-pdf.html` / `.csv` を作ります。このタグの付け外ししかせず、再実行すると現在の状態に合わせて付け直すので、dry run はありません。
3. HTML の DOI リンクから出版社のページを開き、Zotero Connector で保存します。保存したものは新しいアイテムになります。
4. `6_absorb.js`：直近に保存したアイテムを DOI で既存アイテムに統合し、arXiv 版 PDF をゴミ箱に移します。まず dry-run で確認してください。

PDF の判定は、1〜2 ページ目に arXiv の刻印（`arXiv:XXXX.XXXXXvN [astro-ph…]`）があるかどうかで行います。判定できないもの（画像だけの PDF など）には触れません。リンクファイルの場合、ゴミ箱を空にしても PDF のファイル自体はディスクに残ります。

## 最初の整理のあと

最初の整理のあとの作業は、次の 3 つです。ライブラリを変更する作業の前には、Zotero を終了して `zotero.sqlite` をバックアップしてください。`3_apply.js` は本実行のたびに自分でバックアップを作りますが、`4_trash_arxiv_pdf.js`・`5_needs_list.js`・`6_absorb.js` は作りません。スクリプトは、いつもこのリポジトリの最新版から貼り付けてください。別の場所に保存したコピーは使わないでください。

### A. 既存の論文の出版版 PDF を取り込む

Zotero Connector で出版版を保存したら、いつでも実行できます。ほかの手順は不要で、SciX にも問い合わせません。

1. `~/Zotero/scix-work/needs-pub-pdf.html`（`5_needs_list.js` が作成）を開き、DOI のリンクから Zotero Connector で論文を保存します。保存したものは新しいアイテムになります。
2. `6_absorb.js` を、まず dry run で実行します。新しいアイテムを DOI が同じ既存アイテムに統合し、出版版 PDF が付いたら arXiv 版 PDF をゴミ箱に移します（注釈のある PDF は残します）。DOI の誤記や予稿集全体の DOI の可能性があるので、タイトルが既存アイテムと大きく異なる新しいアイテムは統合せず、`SKIP` として表示します。
   - 直近 `days` 日（`CFG`、既定は 7 日）に追加されたアイテムを、新しく保存したものとみなします。保存してから日数がたった場合は `days` を大きくしてください。その期間内に追加したアイテムは、統合先にはなりません。
   - 既存アイテムの DOI 欄に、出版版の DOI が入っている必要があります。一覧に載っているアイテムには、通常は入っています。
   - DOI が同じ既存アイテムが 2 件以上あると、統合しません（`SKIP(既存が複数)`）。先に B か手作業で、その重複をマージしてください。
3. 必要なら `5_needs_list.js` をもう一度実行して、一覧と `_scix:needs-pub-pdf` タグを更新します。

### B. arXiv から新しく取り込んだ論文

論文を取り込んだときに、何かをする必要はありません。1〜3 か月ごとに、手順全体を 1 回回します。

1. `zotero.sqlite` をバックアップします。`scix-work/apply-log.jsonl` は消さずに残します。
2. 上の手順 1〜3 を実行します。`make_queries.py` が新しい `queries.json` を作り、`2_query.js` は前回の結果を使い回さずに、そのクエリをすべて実行し直します。`2_query.js` が途中で止まった場合（1 日の上限など）は、もう一度実行すれば続きから実行します。
3. `3_apply.js` は、`apply-log.jsonl` に完了（`ok` / `noop`）として記録された操作を飛ばします。スキップやエラーになった操作は、もう一度試します。前回のあとに追加した論文は、既存のアイテムとのマージも含めて、初回と同じように処理されます（どちらを残すかは初回と同じ規則で決まります）。前回と違う SciX レコードに一致した論文（多くは、その後出版された arXiv 論文）は、「NASA SciX」「Publisher」リンクも含めて新しいレコードで更新されます。
4. `4_trash_arxiv_pdf.js`（まず dry run）と `5_needs_list.js` を実行し、出版版 PDF は A で取り込みます。

### C. ライブラリ全体を見直す

たとえば、このスクリプトを更新したあとです。

- **通常は B を実行します。** `apply-log.jsonl` を残しておけば、反映されるのは、前回のあとに追加した論文、SciX の一致先が変わった論文、前回の計画になかった操作（更新したスクリプトが新たに見つけたマージや ADS の置き換えなど）です。完了として記録済みの操作は、更新したスクリプトなら別の結果になる場合でも、やり直しません。
- **最初からやり直す場合は**、Zotero を終了し、最初の本実行の直前に作られたバックアップ（いちばん古い `scix-work/backup/zotero.sqlite.pre-apply-…`）を `zotero.sqlite` として戻します。`apply-log.jsonl` を別の場所に移してから、最初の手順から実行します。そのバックアップのあとにライブラリで行った変更は、すべて失われます。Zotero の同期を使っている場合は、サーバー側の状態に注意してください。
- バックアップを戻さずに `apply-log.jsonl` だけを移すと、`3_apply.js` は全アイテムを更新し直します。手で直した値は上書きされ、`_scix:published-update` タグも付け直されます。それが目的のときだけ行ってください。

## 注意

- SciX API の上限は 1 日 5,000 リクエストです。各スクリプトは残り回数を表示します。
- 適用中は、対象アイテムを手で編集しないでください。計画を作ったあとに URL 欄が変わったアイテムは、安全のためスキップします。
- 元に戻すときは、Zotero を終了して `scix-work/backup/` のファイルを `zotero.sqlite` として置き換えます。ただし同期を使っている場合は、サーバー側の状態との関係に注意してください。
- ご自身のライブラリで、自己責任で使ってください。

## ライセンス

MIT
