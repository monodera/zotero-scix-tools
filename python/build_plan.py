#!/usr/bin/env python3
"""Build scix-work/plan.json (consumed by zotero/3_apply.js) and review.html.

Inputs (in --workdir):
  resolve.json         from zotero/1_resolve.js            (required)
  query-results.json   from zotero/2_query.js              (optional)
  manual.json          your own decisions, see examples/   (optional)
Outputs:
  plan.json            operations to apply
  resolution.json      per-item SciX match (used by make_queries.py --round 2)
  review.html          things a human should look at before applying

Usage:
  python3 build_plan.py [--workdir ~/Zotero/scix-work]
"""
import argparse
import collections
import html
import json
import os
import re
from urllib.parse import quote, unquote

from scix_common import (DEFAULT_WORKDIR, PUB_OK, Data, accept_title, au_ok, dtitle, is_pub, lastname,
                         nn, own_ax, pick_hit, pub_doi, title_accept, tsim)

TYPE_MAP = {'article': 'journalArticle', 'inproceedings': 'conferencePaper'}
PAPER_TYPES = ('preprint', 'journalArticle', 'conferencePaper', 'webpage')
LINKED_URL = 3   # Zotero.Attachments.LINK_MODE_LINKED_URL
# ADS の URL。URL に使える ASCII 文字（" < > を除く）だけを取るので、日本語の「。」などで止まる
ADSURL = re.compile(r'https?://(?:ui\.)?adsabs\.harvard\.edu/[!#-;=?-~]*')
# bibcode は19文字ちょうど。& は &amp; / %26、. は %2E になりうる
BIBPAT = r'[0-9]{4}(?:[A-Za-z0-9.]|&amp;|&|%26|%2[Ee]){15}'
ADSBIBHEAD = re.compile(r'https?://(?:ui\.)?adsabs\.harvard\.edu/(?:abs|link_gateway|cgi-bin/nph-data_query\?bibcode=)/?'
                        r'(' + BIBPAT + r')')
ADSBIB = re.compile(ADSBIBHEAD.pattern + r'(?:[/?#&]|$)')
ADSDOI = re.compile(r'https?://(?:ui\.)?adsabs\.harvard\.edu/doi/(10\..+)')


def trim_url(u):
    """URL の直後に続く文の句読点を除く。閉じ括弧は対応する開き括弧がない場合だけ除く。
    bibcode は "." で終わることがあるので、bibcode の部分は削らない。"""
    m = ADSBIBHEAD.match(u)
    keep = m.end() if m else 0
    while len(u) > keep and (u[-1] in '.,;:!?\'' or (u[-1] == ')' and u.count(')') > u.count('('))
                 or (u[-1] == ']' and u.count(']') > u.count('['))):
        u = u[:-1]
    return u


def clean_title(t):
    t = re.sub(r'<SUP>(.*?)</SUP>', r'<sup>\1</sup>', t, flags=re.I)
    t = re.sub(r'<SUB>(.*?)</SUB>', r'<sub>\1</sub>', t, flags=re.I)
    t = re.sub(r'<(?!/?(?:sup|sub|i|b)>)[^>]*>', '', t)
    return html.unescape(t).strip()


def pdate(d):
    m = re.match(r'(\d{4})-(\d{2})', d.get('pubdate') or '')
    if not m:
        return d.get('year') or ''
    return m.group(1) if m.group(2) == '00' else f'{m.group(1)}-{m.group(2)}'


def pages(d):
    if d.get('page_range'):
        return d['page_range']
    p = (d.get('page') or [None])[0]
    return p if p and not p.lower().startswith('arxiv') else ''


def scix_url(b):
    return 'https://scixplorer.org/abs/' + quote(b, safe='') + '/abstract'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--workdir', default=DEFAULT_WORKDIR)
    a = ap.parse_args()
    W = a.workdir
    D = Data(W)
    snap, out, docs, QR = D.snap, D.out, D.docs, D.qr
    mp = os.path.join(W, 'manual.json')
    MANUAL = json.load(open(mp, encoding='utf-8')) if os.path.exists(mp) else {}
    for k, ax in MANUAL.get('addAx', {}).items():
        if k in snap and ax not in snap[k]['ids']['ax']:
            snap[k]['ids']['ax'].append(ax)
    FORCE = set(MANUAL.get('forceFull', []))
    FORCE |= {k for k, s in snap.items() if re.match(r'\s*arXiv:\d', s['title'] or '')}   # broken titles
    REVIEW = collections.defaultdict(list)
    if D.qr_missing:
        print(f'WARNING: 追加検索のうち {len(D.qr_missing)} 件の結果がありません（2_query.js のエラーまたは未実行）。'
              '該当アイテムは「一致なし」や「arXiv版のみ」として扱われます。2_query.js を再実行してから build_plan.py を再実行してください。')
        REVIEW['追加検索の結果がない（2_query.js を再実行してから build_plan.py を再実行）'] = \
            [(k, None, None) for k in sorted({q['key'] for q in D.qr_missing}) if k in snap]
    if D.qr_failed:
        print(f'WARNING: 追加検索のうち {len(D.qr_failed)} 件が 4xx エラーでした（クエリ自体の問題）。'
              '該当アイテムは「一致なし」や「arXiv版のみ」として扱われます。詳細は query-results.json の stats.errors を参照してください。')
        REVIEW['追加検索がエラー（クエリ自体の問題で、再実行しても解決しない可能性が高い。手作業で確認）'] = \
            [(k, None, None) for k in sorted({q['key'] for q in D.qr_failed}) if k in snap]

    # ---------- 1. resolve each item to a SciX record ----------
    RES = {}
    for k, s in snap.items():
        if k in MANUAL.get('resolve', {}):
            b = MANUAL['resolve'][k]
            if b and b not in docs:
                print(f'WARNING manual.json: {b} が SciX 検索結果にありません（{k}）。2_query.js で取得してください。')
                b = None
            RES[k] = {'bib': b, 'method': 'manual' if b else 'manual-none'}
            continue
        b, sim = pick_hit(D, k)
        if b:
            RES[k] = {'bib': b, 'method': 'id', 'sim': sim}
            if out[k]['hits'][b] == ['doi'] and sim < 0.5 and not au_ok(s, docs[b]):
                REVIEW['DOIで一致したがタイトル・著者が大きく異なる（Zoteroのデータが誤りの可能性）'].append((k, b, sim))
            continue
        acc = title_accept(D, k)
        if acc:
            RES[k] = {'bib': acc[0], 'method': 'title', 'sim': acc[1]}
            continue
        best, weak = None, []
        for tag in ('A', 'B', 'C', 'D'):
            for d in QR.get(f'{k}|{tag}') or []:
                sm = tsim(s['title'], dtitle(d))
                if accept_title(s, d, sm):
                    if best is None or sm > best[1]:
                        best = (d['bibcode'], sm)
                elif sm >= 0.6 and (au_ok(s, d) or not s['firstAuthor']):
                    weak.append((k, d['bibcode'], sm))
        if best:
            RES[k] = {'bib': best[0], 'method': 'title2', 'sim': best[1]}
        else:
            RES[k] = {'bib': None, 'method': 'none'}
            REVIEW['見つからなかった（類似候補）'] += sorted(set(weak), key=lambda x: -x[2])[:3]

    # series papers (I, II, III...) matched only by a truncated title are ambiguous
    for k, r in RES.items():
        if r['method'] in ('title', 'title2'):
            zt, dt = norm_title(snap[k]['title']), norm_title(dtitle(docs[r['bib']]))
            if dt.startswith(zt) and re.search(r'\b(i|ii|iii|iv|v|vi|vii|viii|ix|x|paper)\b', dt[len(zt):]):
                REVIEW['タイトルが途中までしか一致しない連番論文（I, II…の取り違えに注意）'].append((k, r['bib'], r['sim']))

    # ---------- 1b. e-print -> separately indexed published record ----------
    for k, r in RES.items():
        b = r['bib']
        if not b or r['method'].startswith('manual') or is_pub(docs[b]):
            continue
        e = docs[b]
        eax = own_ax(e)
        cands = []
        for d in QR.get(k + '|P') or []:
            if d.get('doctype') not in PUB_OK or re.search(r'erratum|corrigendum', dtitle(d), re.I):
                continue
            if int(d.get('year') or 0) < int(e.get('year') or 0):
                continue
            dax = own_ax(d)
            if dax and eax and not (dax & eax):
                continue
            cands.append((tsim(dtitle(e), dtitle(d)), nn(lastname(e)) == nn(lastname(d)), d))
        cands.sort(key=lambda x: -x[0])
        if cands:
            sm, au, d = cands[0]
            if sm >= 0.9 and au:
                r.update(bib=d['bibcode'], method=r['method'] + '+pubrec', eprint=b)
            elif sm >= 0.6 and au:
                REVIEW['arXiv版のみ一致・出版版らしき別レコードあり（タイトル変更の可能性）'].append((k, d['bibcode'], sm))

    # ---------- 2. duplicates ----------
    par = {k: k for k in snap}

    def f(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    idx = collections.defaultdict(list)
    for k, s in snap.items():
        if s['type'] == 'webpage' and not s['ids']['ax']:
            continue
        if RES[k]['bib']:
            idx['bib:' + RES[k]['bib']].append(k)
        for x in s['ids']['ax']:
            idx['ax:' + x].append(k)
        for x in s['ids']['doi']:
            idx['doi:' + x].append(k)
    for ks in idx.values():
        for x in ks[1:]:
            par[f(x)] = f(ks[0])
    for g in MANUAL.get('merge', []):
        for x in g[1:]:
            par[f(x)] = f(g[0])
    groups = collections.defaultdict(list)
    for k in snap:
        groups[f(k)].append(k)
    nomerge = {frozenset(p) for p in MANUAL.get('nomerge', [])}
    forced = {frozenset((g[0], y)) for g in MANUAL.get('merge', []) for y in g[1:]}

    def npdf(s):
        return sum(1 for x in s['atts'] if x['contentType'] == 'application/pdf')

    def master_score(k):
        s = snap[k]
        return (s['type'] in ('journalArticle', 'conferencePaper', 'book', 'bookSection', 'thesis'),
                npdf(s) > 0, s['nNotes'] + len(s['atts']), s['collections'] + s['nTags'],
                -int(re.sub(r'\D', '', s['dateAdded'])[:14] or 0))

    def id_strong(k):
        # arXiv ID / bibcode は論文固有。DOI は予稿集全体のDOIや誤記で複数の論文に共有されうるので、タイトルも合う場合のみ
        r = RES[k]
        if r['method'] != 'id':
            return False
        return bool(set(out[k]['hits'].get(r['bib']) or []) & {'ax', 'bib'}) or r['sim'] >= 0.5
    MERGES, merged_away = [], set()
    for g in groups.values():
        if len(g) < 2:
            continue
        g = sorted(g, key=master_score, reverse=True)
        for mg in MANUAL.get('merge', []):
            if mg[0] in g:
                g = [mg[0]] + [x for x in g if x != mg[0]]
        m = g[0]
        if any(p <= set(g) for p in nomerge):
            # 識別子のつながりのどこが誤りかは判断できないので、自動ではマージしない
            REVIEW['nomerge 指定を含む重複グループ（manual.json の merge で明示したもの以外はマージしない）'].append(g)
            for mg in MANUAL.get('merge', []):
                if mg[0] in g and not any(p <= set(mg) for p in nomerge) \
                        and not (set(mg) & (merged_away | {x['master'] for x in MERGES})):
                    MERGES.append({'master': mg[0], 'others': mg[1:]})
                    merged_away.update(mg[1:])
            continue
        weak = [x for x in g[1:] if frozenset((m, x)) not in forced
                and tsim(snap[m]['title'], snap[x]['title']) < 0.5
                and not (set(snap[m]['ids']['ax']) & set(snap[x]['ids']['ax']))
                and not (RES[m]['bib'] and RES[m]['bib'] == RES[x]['bib'] and id_strong(m) and id_strong(x))]
        if weak:
            REVIEW['重複候補（識別子は共通だがタイトルが大きく異なる。マージしない）'].append(g)
            continue
        MERGES.append({'master': m, 'others': g[1:]})
        merged_away.update(g[1:])
    byt = collections.defaultdict(list)
    for k, s in snap.items():
        t = nn(s['title'])
        if len(t) > 20 and s['type'] != 'webpage':
            byt[t].append(k)
    for ks in byt.values():
        if len({f(x) for x in ks}) > 1 and not any(frozenset((x, y)) in nomerge for x in ks for y in ks):
            REVIEW['同じタイトルだが識別子が異なる（マージしない）'].append(ks)

    # ---------- 3. operations ----------
    OPS = [{'id': 'merge:' + m['master'], 'op': 'merge', 'master': m['master'], 'others': m['others']} for m in MERGES]
    MASTER_OF = {m['master']: m['others'] for m in MERGES}
    STATS = collections.Counter()
    MDOI = {}   # manual.json で指定した DOI（PDF の一覧でも SciX の DOI より優先する）

    def arxiv_origin(s):
        return bool(s['ids']['ax']) and (s['type'] in ('preprint', 'webpage') or s['libraryCatalog'] == 'arXiv.org'
                                         or 'arxiv.org' in s['url'])
    for k, s in snap.items():
        if k in merged_away:
            continue
        b = RES[k]['bib']
        d = docs.get(b) if b else None
        axs = sorted({x for y in [k] + MASTER_OF.get(k, []) for x in snap[y]['ids']['ax']})
        # manual.json の fields は、既存の値・SciX 由来の値より優先して設定する
        mf = {kk: v for kk, v in (MANUAL.get('fields', {}).get(k) or {}).items() if v}
        mdoi = (mf.get('DOI') or '').lower()
        if mdoi:
            MDOI[k] = mdoi
            s['ids']['doi'] = [mdoi] + [x for x in s['ids']['doi'] if x != mdoi]
            # URL 欄が DOI のリンクなら、指定した DOI のリンクにする（URL を明示していればそちらを優先）
            if 'url' not in mf and re.match(r'https?://(dx\.)?doi\.org/', s['url'] or '', re.I):
                mf['url'] = 'https://doi.org/' + mdoi
        if d is None:
            if mf:
                OPS.append({'id': 'upd:' + k, 'op': 'update', 'key': k, 'fields': mf, 'extraLines': [], 'tags': []})
            if s['ids']['doi']:
                OPS.append({'id': 'link:pub:' + k, 'op': 'link', 'key': k, 'title': 'Publisher',
                            'url': 'https://doi.org/' + s['ids']['doi'][0]})
                STATS['SciXなし・DOIあり'] += 1
            elif k not in MANUAL.get('links', {}) and s['type'] != 'webpage':
                STATS['SciXなし・DOIなし'] += 1
                REVIEW['リンクを付けられないアイテム（手作業で）'].append((k, None, None))
            continue
        pub, doi = is_pub(d), pub_doi(d)
        fields, set_type, tags = {}, None, []
        if pub:
            target = TYPE_MAP.get(d.get('doctype'))
            if (arxiv_origin(s) or k in FORCE) and target and s['type'] in PAPER_TYPES:
                if s['type'] != target:
                    set_type = target
                venue = 'publicationTitle' if target == 'journalArticle' else 'proceedingsTitle'
                fields = {venue: html.unescape(d.get('pub') or ''), 'volume': d.get('volume') or '',
                          'pages': pages(d), 'date': pdate(d), 'DOI': doi or ''}
                if target == 'journalArticle':
                    fields['issue'] = d.get('issue') or ''
                    fields['journalAbbreviation'] = (d.get('bibstem') or [''])[0]
                nt = clean_title(dtitle(d))
                if nt and tsim(s['title'], nt) < 0.995:
                    fields['title'] = nt
                if doi:
                    fields['url'] = 'https://doi.org/' + doi
                tags.append('_scix:published-update')
                STATS['出版版メタデータに更新'] += 1
            else:   # keep existing values, fill empty fields only
                valid = {'journalArticle': {'volume', 'pages', 'DOI', 'issue', 'publicationTitle'},
                         'conferencePaper': {'volume', 'pages', 'DOI'}, 'preprint': {'DOI'},
                         'book': {'volume', 'DOI'}, 'bookSection': {'pages', 'DOI'},
                         'report': {'pages', 'DOI'}}.get(s['type'], set())
                cand = {'volume': d.get('volume') or '', 'pages': pages(d), 'DOI': doi or '',
                        'issue': d.get('issue') or '', 'publicationTitle': html.unescape(d.get('pub') or '')}
                fields = {kk: v for kk, v in cand.items() if v and kk in valid and not s.get(kk)}
                if not s['date'] and pdate(d) and s['type'] != 'computerProgram':
                    fields['date'] = pdate(d)
                if fields:
                    STATS['空欄のみ補完'] += 1
        elif s['type'] == 'webpage' and axs:      # arXiv abstract page saved as a web page
            set_type = 'preprint'
            fields = {'repository': 'arXiv', 'archiveID': 'arXiv:' + axs[0], 'DOI': '10.48550/arXiv.' + axs[0],
                      'url': 'https://arxiv.org/abs/' + axs[0], 'date': pdate(d)}
            nt = clean_title(dtitle(d))
            if nt and tsim(s['title'], nt) < 0.995:
                fields['title'] = nt
        if mdoi and fields.get('url', '').startswith('https://doi.org/'):
            fields['url'] = 'https://doi.org/' + mdoi
        fields.update(mf)
        upd = {'id': 'upd:' + k, 'op': 'update', 'key': k, 'fields': {kk: v for kk, v in fields.items() if v},
               'extraLines': ['Bibcode: ' + b] + ([f'arXiv: {axs[0]}'] if axs else []), 'tags': tags}
        if set_type:
            upd['setType'] = set_type
        OPS.append(upd)
        OPS.append({'id': 'link:scix:' + k, 'op': 'link', 'key': k, 'title': 'NASA SciX', 'url': scix_url(b)})
        pd = mdoi or doi or (s['ids']['doi'][0] if s['ids']['doi'] and not pub else None)
        if pd:
            OPS.append({'id': 'link:pub:' + k, 'op': 'link', 'key': k, 'title': 'Publisher', 'url': 'https://doi.org/' + pd})
        STATS['SciX一致（出版版）' if pub else 'SciX一致（arXivのみ）'] += 1
    for k, links in MANUAL.get('links', {}).items():
        for i, l in enumerate(links):
            OPS.append({'id': f'link:man{i}:{k}', 'op': 'link', 'key': k, 'title': l['title'], 'url': l['url']})

    # ---------- 4. ADS -> SciX ----------
    doi2bib = {}
    for bb, dd in docs.items():
        for x in dd.get('doi') or []:
            doi2bib.setdefault(x.lower(), bb)

    def ads_id(u):
        """ADS の URL が指すもの -> ('doi', doi) / ('bib', bibcode) / None（検索ページなど）"""
        mu = ADSURL.search(u)
        if not mu:
            return None
        u = trim_url(mu.group(0))
        md = ADSDOI.match(u)
        if md:
            return 'doi', html.unescape(unquote(md.group(1))).lower()
        m = ADSBIB.match(u)
        return ('bib', html.unescape(unquote(m.group(1)))) if m else None

    def ads2scix(u):
        r = ads_id(u)
        if not r:
            return None
        if r[0] == 'doi':
            x = r[1]
            return scix_url(doi2bib[x]) if x in doi2bib else 'https://scixplorer.org/search?q=' + quote(f'doi:"{x}"')
        return scix_url(r[1])

    def same_paper(u, b):
        """ADS の URL u が SciX レコード b を指すか（arXiv版などの別名 bibcode・DOI を含む）"""
        r, d = ads_id(u), docs.get(b) or {}
        if not r:
            return False
        if r[0] == 'doi':
            return doi2bib.get(r[1]) == b or r[1] in {x.lower() for x in d.get('doi') or []}
        return r[1] == b or r[1] in (d.get('identifier') or [])
    url_set = {o['key'] for o in OPS if o['op'] == 'update' and 'url' in o['fields']}
    scix_link = {o['key']: o for o in OPS if o['id'].startswith('link:scix:')}
    owner = {x: m for m, xs in MASTER_OF.items() for x in xs}   # マージ後に添付が移る先
    for k, s in snap.items():
        if 'adsabs' in s['url'] and k not in merged_away and k not in url_set:
            t = ads2scix(s['url'])
            if t:
                OPS.append({'id': 'url:' + k, 'op': 'setUrl', 'key': k, 'from': s['url'], 'to': t})
                STATS['ADS→SciX（URL欄）'] += 1
        lk = scix_link.get(owner.get(k, k))
        for x in s['atts']:
            if 'adsabs' in (x['url'] or ''):
                if lk and 'adopt' not in lk and x['linkMode'] == LINKED_URL \
                        and same_paper(x['url'], RES[owner.get(k, k)]['bib']):
                    # 同じ論文を指す ADS リンクなら、SciX リンクを新しく足すと重複するので、これを SciX リンクに書き換える
                    lk['adopt'] = x['key']
                    STATS['ADS→SciX（リンク添付）'] += 1
                    continue
                t = ads2scix(x['url'])
                if t:
                    OPS.append({'id': 'url:' + x['key'], 'op': 'setUrl', 'key': x['key'], 'from': x['url'], 'to': t})
                    STATS['ADS→SciX（添付のURL）'] += 1
    for nk, body in (D.raw.get('adsNoteBodies') or {}).items():
        pairs = []
        for m in {trim_url(x.group(0)) for x in ADSURL.finditer(body)}:
            t = ads2scix(m)
            if t:
                pairs.append([m, t])
        if pairs:
            # 3_apply.js は順に split/join するので、他の URL の前方一致になる短い URL を後にする
            pairs.sort(key=lambda p: -len(p[0]))
            OPS.append({'id': 'note:' + nk, 'op': 'noteReplace', 'key': nk, 'pairs': pairs})
            STATS['ADS→SciX（ノート）'] += 1

    # ---------- 5. items whose arXiv PDF could be replaced by the publisher PDF ----------
    PDF = []
    for k, s in snap.items():
        if k in merged_away:
            continue
        grp = [k] + MASTER_OF.get(k, [])
        b = RES[k]['bib']
        d = docs.get(b) if b else None
        pd = d and (MDOI.get(k) or pub_doi(d))
        if d and is_pub(d) and pd and any(snap[x]['ids']['ax'] for x in grp) and any(npdf(snap[x]) for x in grp):
            PDF.append({'key': k, 'doi': pd, 'bibcode': b, 'pubPdf': 'PUB_PDF' in (d.get('esources') or []),
                        'prefix': pd.split('/')[0]})

    plan = {'generated': D.raw.get('generated'), 'ops': OPS, 'pdf': PDF}
    json.dump(plan, open(os.path.join(W, 'plan.json'), 'w', encoding='utf-8'))
    json.dump(RES, open(os.path.join(W, 'resolution.json'), 'w', encoding='utf-8'))
    write_review(W, REVIEW, snap, docs, STATS, MERGES)

    print('マージ:', len(MERGES), 'グループ /', len(merged_away), '件を統合')
    print('操作:', dict(collections.Counter(o['op'] for o in OPS)))
    print('統計:', dict(STATS))
    print('照合方法:', dict(collections.Counter(r['method'] for r in RES.values())))
    print('出版版PDFの差し替え候補:', len(PDF))
    print('要確認:', {k: len(v) for k, v in REVIEW.items() if v}, '→ review.html')


def norm_title(t):
    from scix_common import norm
    return norm(t)


def write_review(W, REVIEW, snap, docs, STATS, MERGES):
    e = html.escape

    def item(k):
        s = snap[k]
        return (f'<a href="zotero://select/library/items/{k}">{e(k)}</a> {e(s["firstAuthor"] or "")} '
                f'{e(str(s["year"] or ""))} — {e(s["title"][:120])}')

    def doc(b):
        if not b:
            return ''
        d = docs.get(b, {})
        return f'<a href="https://scixplorer.org/abs/{quote(b, safe="")}/abstract">{e(b)}</a> {e(dtitle(d)[:120])}'
    h = ['<!doctype html><meta charset="utf-8"><title>SciX plan review</title>',
         '<style>body{font:14px/1.5 -apple-system,sans-serif;margin:24px;max-width:1200px}'
         'li{margin:4px 0}.s{color:#666}</style>',
         '<h1>適用前の確認リスト</h1>',
         '<p class="s">アイテムキーをクリックするとZoteroでそのアイテムが開きます。対応付けを直したい場合は manual.json に書いて build_plan.py を再実行してください。</p>',
         '<h2>集計</h2><ul>'] + [f'<li>{e(k)}: {v}</li>' for k, v in STATS.items()] + [f'<li>マージ: {len(MERGES)} グループ</li></ul>']
    for cat, rows in REVIEW.items():
        if not rows:
            continue
        h.append(f'<h2>{e(cat)}（{len(rows)}）</h2><ul>')
        for r in rows:
            if isinstance(r, list):
                h.append('<li>' + '<br>'.join(item(k) for k in r) + '</li>')
            else:
                k, b, sm = r
                h.append(f'<li>{item(k)}' + (f'<br>→ {doc(b)} <span class="s">(類似度 {sm:.2f})</span>' if b else '') + '</li>')
        h.append('</ul>')
    h.append('<h2>マージ予定</h2><ul>')
    for m in MERGES:
        h.append('<li>' + item(m['master']) + ''.join('<br>　← ' + item(x) for x in m['others']) + '</li>')
    h.append('</ul>')
    open(os.path.join(W, 'review.html'), 'w', encoding='utf-8').write('\n'.join(h))


if __name__ == '__main__':
    main()
