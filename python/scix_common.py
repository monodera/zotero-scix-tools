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
        self.qr = {}
        qp = os.path.join(workdir, 'query-results.json')
        if os.path.exists(qp):
            self.qr = json.load(open(qp, encoding='utf-8')).get('results', {})
            for v in self.qr.values():
                for d in v or []:
                    self.docs.setdefault(d['bibcode'], d)
        # queries.json にあるが結果がない（2_query.js のエラー・未実行）クエリ。「一致なし」とは区別する
        self.qr_missing = []
        qj = os.path.join(workdir, 'queries.json')
        if os.path.exists(qj):
            self.qr_missing = [q['id'] for q in json.load(open(qj, encoding='utf-8')).get('queries', [])
                               if self.qr.get(q['id']) is None]


# ---------------- text helpers ----------------
def norm(t):
    t = html.unescape(t or '')
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'\$[^$]*\$', ' ', t)
    t = re.sub(r'\\[a-zA-Z]+', ' ', t)
    t = unicodedata.normalize('NFKD', t)
    t = ''.join(ch for ch in t if not unicodedata.combining(ch))
    return ' '.join(re.findall(r'[a-z0-9]+', t.lower()))


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
    t = html.unescape(t or '')
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'\$[^$]*\$', ' ', t)
    t = re.sub(r'\\[a-zA-Z]+', ' ', t)
    t = unicodedata.normalize('NFKD', t)
    t = ''.join(ch for ch in t if not unicodedata.combining(ch)).lower()
    out = []
    for x in re.findall(r'[a-z0-9]+', t):
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
