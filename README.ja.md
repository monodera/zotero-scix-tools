# zotero-scix-tools

天文学の論文を Zotero で管理している人向けに、ライブラリを [NASA Science Explorer (SciX)](https://scixplorer.org/) と照合して整理するスクリプト集です。

[English README](README.md)

## できること

- **重複のマージ**：arXiv ID・DOI・SciX bibcode が一致するもの（arXiv 版と出版版の組を含む）を自動でマージします。タイトルが似ているだけのものはマージせず、確認リストに出します。
- **出版版への更新**：arXiv 論文が出版済みなら、アイテムタイプを Journal Article / Conference Paper に変え、雑誌名・巻・号・ページ・出版日・DOI・タイトルを出版版に合わせます。arXiv ID は Extra 欄に残します。
- **リンクの追加**：各アイテムに「NASA SciX」と「Publisher」（doi.org）のリンク添付を付けます。
- **ADS から SciX への置き換え**：URL 欄・添付の URL・ノート中の ADS リンクを SciX のものに置き換えます。
- **arXiv 版 PDF の整理**：出版版 PDF がすでにある場合、arXiv 版 PDF をゴミ箱に移します。PDF に書き込みのあるものは残します。
- **出版版 PDF の手動取得の補助**：未取得の論文をリスト（HTML/CSV）にします。Zotero Connector で保存したあと、既存アイテムに統合できます。

SciX で見つからない論文は、DOI があれば出版社のリンクを付けます。どちらもないものは確認リストに出します。

## 方針

- **すべて Zotero の中で動きます。** スクリプトは Zotero の「Run JavaScript」で実行します。Zotero を終了する必要はありません。変更は通常の編集と同じ扱いなので、Zotero の同期にもそのまま乗ります。
- **計画を作ってから適用します。** 照合（読み取りのみ）→ 計画の作成（Python）→ 人の目で確認 → 適用、の順に進みます。適用には dry-run があり、途中で止まっても続きから再開できます。初回の本実行の直前に、データベースのバックアップを自動で作ります。
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

- まだ見つからないものが多ければ、`python3 make_queries.py --round 2` → `2_query.js` → `build_plan.py` をもう一度回します。年を条件から外して検索し直します。
- 対応付けを直したいとき、マージしたくない組があるとき、手で調べたリンクを付けたいときは、`examples/manual.example.json` を参考に `scix-work/manual.json` を書いて、`build_plan.py` を再実行します。

### 3. 適用

`3_apply.js` を次の順に実行します。

1. `dryRun: true` で実行し、件数を確認します（変更はしません。詳細は `dryrun-report.json` に出ます）。
2. `dryRun: false, limit: 5, only: ['merge']` で実行し、Zotero 上でマージの結果を確認します。最初の本実行では、`scix-work/backup/` にデータベースのバックアップが作られます。
3. `limit: 0, only: null` で全件を実行します。実行済みの操作はスキップされます（`apply-log.jsonl`）。

更新したアイテムには `_scix:published-update` タグが付きます。確認が済んだら、タグごと一括で削除できます。

### 4. PDF の整理

1. `4_trash_arxiv_pdf.js`：まず dry-run、問題なければ `dryRun: false` で実行します。出版版 PDF と arXiv 版 PDF が両方あるアイテムから、arXiv 版をゴミ箱に移します。
2. `5_needs_list.js`：出版版 PDF がないアイテムに `_scix:needs-pub-pdf` タグを付け、`needs-pub-pdf.html` / `.csv` を作ります。
3. HTML の DOI リンクから出版社のページを開き、Zotero Connector で保存します。保存したものは新しいアイテムになります。
4. `6_absorb.js`：直近に保存したアイテムを DOI で既存アイテムに統合し、arXiv 版 PDF をゴミ箱に移します。まず dry-run で確認してください。

PDF の判定は、1〜2 ページ目に arXiv の刻印（`arXiv:XXXX.XXXXXvN [astro-ph…]`）があるかどうかで行います。判定できないもの（画像だけの PDF など）には触れません。リンクファイルの場合、ゴミ箱を空にしても PDF のファイル自体はディスクに残ります。

## 注意

- SciX API の上限は 1 日 5,000 リクエストです。各スクリプトは残り回数を表示します。
- 適用中は、対象アイテムを手で編集しないでください。計画を作ったあとに URL 欄が変わったアイテムは、安全のためスキップします。
- 元に戻すときは、Zotero を終了して `scix-work/backup/` のファイルを `zotero.sqlite` として置き換えます。ただし同期を使っている場合は、サーバー側の状態との関係に注意してください。
- ご自身のライブラリで、自己責任で使ってください。

## ライセンス

MIT
