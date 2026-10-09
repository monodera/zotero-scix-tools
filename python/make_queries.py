#!/usr/bin/env python3
"""Create scix-work/queries.json for zotero/2_query.js.

Round 1 (after 1_resolve.js):
  * items not matched by identifier or by the strict title search
      A: first author + any title word (+ year range)
      B: six title words, all required (+ year range)
  * items that only matched an arXiv e-print record
      P: look for a separately indexed published version
Round 2 (after a first build_plan.py run):
  * items still unresolved: same as A/B but without the year restriction
  * items that the extra searches matched only to an e-print record: P, as in round 1
    (PDF-derived metadata often has a wrong year)

Usage:
  python3 make_queries.py [--workdir ~/Zotero/scix-work] [--round 1|2]
"""
import argparse
import datetime
import json
import os

from scix_common import (DEFAULT_WORKDIR, FL, Data, dtitle, is_pub, lastname, pick_hit, qq,
                         title_accept, words)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--workdir', default=DEFAULT_WORKDIR)
    ap.add_argument('--round', type=int, default=1, choices=(1, 2))
    a = ap.parse_args()
    D = Data(a.workdir)
    qs = []

    def pub_query(k, s, d):
        # e-print only: is the published version indexed as a separate record?
        w = words(dtitle(d) or s['title'])
        la = lastname(d) or s['firstAuthor']
        if la and len(w) >= 2:
            qs.append({'id': k + '|P', 'key': k, 'rows': 5,
                       'q': f"author:{qq('^' + la)} title:(" + ' OR '.join(w) +
                            f") year:{d.get('year')}-2100 -doctype:eprint"})

    if a.round == 1:
        for k, s in D.snap.items():
            if s['type'] == 'webpage' and not s['ids']['ax']:
                continue
            b, _ = pick_hit(D, k)
            if b:
                d = D.docs[b]
                if not is_pub(d):
                    pub_query(k, s, d)
                continue
            acc = title_accept(D, k)
            if acc:
                # タイトル検索で e-print にだけ一致した場合も、出版版を探す
                if not is_pub(D.docs[acc[0]]):
                    pub_query(k, s, D.docs[acc[0]])
                continue
            if not s['title']:
                continue
            w = words(s['title'])
            if len(w) < 2:
                continue
            yr = f" year:{int(s['year']) - 1}-{int(s['year']) + 1}" if s['year'] else ''
            if s['firstAuthor']:
                qs.append({'id': k + '|A', 'key': k, 'rows': 8,
                           'q': f"author:{qq('^' + s['firstAuthor'])} title:(" + ' OR '.join(w) + ')' + yr})
            qs.append({'id': k + '|B', 'key': k, 'rows': 8, 'q': 'title:(' + ' '.join(w[:6]) + ')' + yr})
    else:
        rp = os.path.join(a.workdir, 'resolution.json')
        if not os.path.exists(rp):
            raise SystemExit('resolution.json がありません。先に build_plan.py を実行してください。')
        res = json.load(open(rp, encoding='utf-8'))
        for k, r in res.items():
            s = D.snap[k]
            if r['method'] == 'title2' and not is_pub(D.docs[r['bib']]) and D.qr.get(k + '|P') is None:
                # 追加検索（A〜D）で e-print にだけ一致した場合も、出版版を探す
                pub_query(k, s, D.docs[r['bib']])
                continue
            if r['bib'] or not s['title'] or s['type'] == 'webpage':
                continue
            w = words(s['title'], 8)
            if len(w) < 2:
                continue
            au = f"author:{qq('^' + s['firstAuthor'])} " if s['firstAuthor'] else ''
            qs.append({'id': k + '|C', 'key': k, 'rows': 6, 'q': au + 'title:(' + ' '.join(w[:5]) + ')'})
            if au:
                qs.append({'id': k + '|D', 'key': k, 'rows': 8, 'q': au + 'title:(' + ' OR '.join(w) + ')'})

    # 前回の queries.json のうち結果がまだないもの（2_query.js のエラー・未実行）は引き継ぐ。
    # 上書きで消えると 2_query.js で再試行されず、build_plan.py の警告も出なくなるため
    ids = {q['id'] for q in qs}
    carry = [q for q in D.qr_missing if q['id'] not in ids]
    qs += carry
    if carry:
        print(f'前回の queries.json から、結果がまだない {len(carry)} 件を引き継ぎました')
    out = os.path.join(a.workdir, 'queries.json')
    # generated: 2_query.js はこれが変わると（作り直したら）全クエリを実行し直す。前回の結果を使い回さないため
    generated = datetime.datetime.now(datetime.timezone.utc).isoformat()
    json.dump({'fl': FL, 'generated': generated, 'queries': qs}, open(out, 'w', encoding='utf-8'))
    print(f'{len(qs)} queries -> {out}')


if __name__ == '__main__':
    main()
