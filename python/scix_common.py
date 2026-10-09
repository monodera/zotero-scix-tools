"""Shared helpers for make_queries.py and build_plan.py (standard library only)."""
import difflib
import html
import json
import os
import re
import unicodedata

DEFAULT_WORKDIR = os.path.expanduser('~/Zotero/scix-work')
FL = ('bibcode,identifier,doi,title,author,year,pubdate,pub,pub_raw,bibstem,'
      'volume,issue,page,page_range,doctype,property,esources')
STOP = set('the of and a an in on for with from to at by as its is are be or via using '
           'new near not into than their our this that'.split())
PUB_OK = ('article', 'inproceedings', 'inbook')


class Data:
    """resolve.json (+ optional query-results.json) loaded into memory."""

    def __init__(self, workdir):
        self.workdir = workdir
        r = json.load(open(os.path.join(workdir, 'resolve.json'), encoding='utf-8'))
        self.raw = r
        self.snap = r['snap']
        self.out = r['out']
        self.docs = r['docs']
        self.qr, qr_4xx, fetched_in = {}, set(), {}
        qp = os.path.join(workdir, 'query-results.json')
        if os.path.exists(qp):
            j = json.load(open(qp, encoding='utf-8'))
            self.qr = j.get('results', {})
            fetched_in = j.get('fetchedIn', {})
            for v in self.qr.values():
                for d in v or []:
                    self.docs.setdefault(d['bibcode'], d)
            # 前回の 2_query.js で 4xx（クエリ自体の問題）になったクエリ
            qr_4xx = {e.get('id') for e in (j.get('stats') or {}).get('errors', [])
                      if isinstance(e.get('status'), int) and 400 <= e['status'] < 500}
        # queries.json にあるが結果がないクエリ。「一致なし」とは区別する。今の queries.json で取得していない
        # 結果（作り直す前のもの）も、2_query.js がまだ実行し直していないので、結果がないものとして扱う
        #   qr_missing: エラー・未実行（2_query.js の再実行で取得できる見込み）
        #   qr_failed:  4xx（再実行しても失敗する可能性が高い）
        self.qr_missing, self.qr_failed = [], []
        self.qr_fetched_in, self.qr_batch = fetched_in, None
        qj = os.path.join(workdir, 'queries.json')
        if os.path.exists(qj):
            qd = json.load(open(qj, encoding='utf-8'))
            self.qr_batch = qd.get('generated')
            for q in qd.get('queries', []):
                if not self.fetched(q['id']):
                    (self.qr_failed if q['id'] in qr_4xx else self.qr_missing).append(q)

    def fetched(self, qid):
        """query-results.json に、今の queries.json で取得した結果がある（作り直す前の古い結果は除く）"""
        return self.qr.get(qid) is not None and (not self.qr_batch or self.qr_fetched_in.get(qid) == self.qr_batch)


# ---------------- text helpers ----------------
def plain(t):
    """Lower-case text without HTML tags, TeX math/commands and accents."""
    t = html.unescape(t or '')
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'\$[^$]*\$', ' ', t)
    t = re.sub(r'\\[a-zA-Z]+', ' ', t)
    t = unicodedata.normalize('NFKD', t)
    return ''.join(ch for ch in t if not unicodedata.combining(ch)).lower()


def norm(t):
    return ' '.join(re.findall(r'[a-z0-9]+', plain(t)))


def nn(s):
    return norm(s).replace(' ', '')


def tsim(a, b):
    """Title similarity in [0,1]: max of sequence ratio and word Jaccard."""
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    r = difflib.SequenceMatcher(None, a, b).ratio()
    wa, wb = set(a.split()), set(b.split())
    return max(r, len(wa & wb) / max(1, len(wa | wb)))


def dtitle(d):
    return (d.get('title') or [''])[0]


def lastname(d):
    a = (d.get('author') or [''])[0]
    return a.split(',')[0].strip()


def words(t, n=10):
    out = []
    for x in re.findall(r'[a-z0-9]+', plain(t)):
        if len(x) >= 3 and x not in STOP and not x.isdigit() and x not in out:
            out.append(x)
    return out[:n]


def qq(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


# ---------------- matching rules ----------------
def yr_ok(s, d, tol=1):
    return (not s['year']) or bool(d.get('year') and abs(int(d['year']) - int(s['year'])) <= tol)


def au_ok(s, d):
    return bool(s['firstAuthor']) and nn(s['firstAuthor']) == nn(lastname(d))


def accept_title(s, d, sm):
    """Accept a title-search candidate only when it is very likely the same paper."""
    au, yo = au_ok(s, d), yr_ok(s, d)
    if s['firstAuthor'] and not au:          # first author disagrees -> near-identical title only
        return sm >= 0.97 and yo
    if not s['firstAuthor']:
        return sm >= 0.95 and yo
    return sm >= 0.9 or (sm >= 0.75 and yo)


BONUS = {'bib': 0.3, 'doi': 0.2, 'ax': 0.1}


def pick_hit(D, k):
    """Best identifier hit for item k -> (bibcode, title_similarity)."""
    s, h = D.snap[k], D.out[k]['hits']
    if not h:
        return None, 0.0
    scored = []
    for b, via in h.items():
        d = D.docs[b]
        sim = tsim(s['title'], dtitle(d))
        score = sim + max(BONUS[v] for v in via) + (0.05 if d.get('doctype') != 'eprint' else 0)
        if d.get('doctype') == 'erratum' or re.search(r'corrigendum|erratum', dtitle(d), re.I):
            score -= 0.5
        scored.append((score, sim, b))
    scored.sort(reverse=True)
    return scored[0][2], scored[0][1]


def title_accept(D, k):
    s, best = D.snap[k], None
    for b in D.out[k].get('titleCands') or []:
        d = D.docs[b]
        sm = tsim(s['title'], dtitle(d))
        if accept_title(s, d, sm) and (best is None or sm > best[1]):
            best = (b, sm)
    return best


def is_pub(d):
    return bool(d) and d.get('doctype') != 'eprint' and 'arXiv' not in (d.get('bibstem') or [''])[0]


def pub_doi(d):
    for x in d.get('doi') or []:
        if not x.lower().startswith('10.48550/'):
            return x
    return None


def own_ax(d):
    return {i.split(':', 1)[1].lower() for i in (d.get('identifier') or []) if i.lower().startswith('arxiv:')}
