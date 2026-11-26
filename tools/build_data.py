# -*- coding: utf-8 -*-
"""Build demo geometry data from ASCII STL samples.

Pipeline: STL -> welded mesh -> region growing into B-Rep-like faces ->
per-face attributes (surface type, axis, radius) -> face adjacency (gAAG edges).
Output: data.json consumed by the demo page.
"""
import base64, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features import build_instances

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 样例 STL 所在目录，按优先级取：
#   1) 环境变量 AAGNET_EXAMPLES
#   2) 与本仓库同级的 AAGNet-main/examples（推荐，AAGNet 官方仓库里的样例件）
SRC = os.environ.get('AAGNET_EXAMPLES') or os.path.join(ROOT, '..', 'AAGNet-main', 'examples')
SRC = os.path.abspath(SRC)


# ---------------------------------------------------------------- STL parsing
def read_ascii_stl(path):
    tris, cur = [], []
    with open(path, 'r', errors='ignore') as f:
        for line in f:
            s = line.strip()
            if s.startswith('vertex'):
                p = s.split()
                cur.append((float(p[1]), float(p[2]), float(p[3])))
                if len(cur) == 3:
                    tris.append(cur)
                    cur = []
    return np.asarray(tris, dtype=np.float64)


def weld(tris, tol=1e-6):
    pts = tris.reshape(-1, 3)
    scale = max(float(np.abs(pts).max()), 1.0)
    key = np.round(pts / (tol * scale)).astype(np.int64)
    uniq, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    V = pts[inv[:len(uniq)]] if inv.ndim else None
    # inverse maps key rows -> index; use first occurrence coordinates
    first_idx = inv  # np.unique with return_index gives index into key rows
    V = pts[first_idx]
    F = inv.reshape(-1) if False else None
    return V, None


def weld2(tris, tol=1e-6):
    pts = tris.reshape(-1, 3)
    scale = max(float(np.abs(pts).max()), 1.0)
    key = np.round(pts / (tol * scale)).astype(np.int64)
    uniq, idx, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    V = pts[idx]
    F = inv.reshape(-1, 3)
    return V, F


def face_normals(V, F):
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1)
    area = ln * 0.5
    n = n / np.maximum(ln[:, None], 1e-15)
    cen = (a + b + c) / 3.0
    return n, area, cen


def adjacency(F):
    edges = {}
    for ti, (i, j, k) in enumerate(F):
        for e in ((i, j), (j, k), (k, i)):
            key = (min(e), max(e))
            edges.setdefault(key, []).append(ti)
    adj = [[] for _ in range(len(F))]
    for ts in edges.values():
        if len(ts) == 2:
            adj[ts[0]].append(ts[1]); adj[ts[1]].append(ts[0])
    return adj


def segment(V, F, angle_deg):
    n, area, cen = face_normals(V, F)
    adj = adjacency(F)
    cos_t = np.cos(np.deg2rad(angle_deg))
    labels = np.full(len(F), -1, dtype=np.int64)
    cur = 0
    for s in range(len(F)):
        if labels[s] >= 0:
            continue
        stack = [s]; labels[s] = cur
        while stack:
            t = stack.pop()
            for u in adj[t]:
                if labels[u] >= 0:
                    continue
                if abs(float(np.dot(n[t], n[u]))) >= cos_t:
                    labels[u] = cur
                    stack.append(u)
        cur += 1
    return labels, cur, n, area, cen


def circle_fit(pts2):
    """Kasa least squares circle fit -> (center, radius)."""
    x, y = pts2[:, 0], pts2[:, 1]
    A = np.column_stack([2 * x, 2 * y, np.ones(len(x))])
    b = x ** 2 + y ** 2
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = sol[0], sol[1]
    r = np.sqrt(max(sol[2] + cx ** 2 + cy ** 2, 1e-12))
    return np.array([cx, cy]), float(r)


def summarize(V, F, labels, nface, n, area, cen):
    faces = []
    for f in range(nface):
        sel = labels == f
        w = area[sel]
        if w.sum() <= 1e-12:
            continue
        mean_n = (n[sel] * w[:, None]).sum(axis=0) / w.sum()
        mean_n /= np.linalg.norm(mean_n) + 1e-15
        c = (cen[sel] * w[:, None]).sum(axis=0) / w.sum()
        vsel = V[F[sel]].reshape(-1, 3)
        bmin, bmax = vsel.min(axis=0), vsel.max(axis=0)
        cosv = np.clip(n[sel] @ mean_n, -1, 1)
        spread = float(np.rad2deg(np.arccos(cosv.min())))
        cov = np.cov(n[sel].T) if sel.sum() > 3 else np.zeros((3, 3))
        evals, evecs = np.linalg.eigh(np.atleast_2d(cov))
        axis = evecs[:, 0]
        stype, radius, axis_pt = 'Plane', None, None
        if spread > 3.0:
            # cylinder: normals perpendicular to a common axis
            if evals[0] / (evals.sum() + 1e-12) < 0.12:
                a = evecs[:, 0]
                a /= np.linalg.norm(a) + 1e-15
                base = np.array([np.abs(a[1]) < 0.9, 0, 0], dtype=bool)
                if abs(a[1]) < 0.9:
                    u = np.cross(a, [0, 1, 0]); u /= np.linalg.norm(u)
                else:
                    u = np.cross(a, [1, 0, 0]); u /= np.linalg.norm(u)
                v = np.cross(a, u)
                P = cen[sel]
                pts2 = np.column_stack([P @ u, P @ v])
                ctr2, r = circle_fit(pts2)
                pts_on_axis = (ctr2[0] * u + ctr2[1] * v)
                # axis point: project onto plane through P mean
                axis_pt = pts_on_axis + a * float(np.mean(P @ a))
                resid = np.abs(np.linalg.norm(pts2 - ctr2, axis=1) - r)
                if resid.mean() < 0.01 and r < 0.9:
                    stype, radius = 'Cylinder', float(r)
                else:
                    stype, radius = 'Freeform/Cone', None
            else:
                stype = 'Freeform/Cone'
        faces.append(dict(
            id=int(f),
            type=stype,
            area=float(w.sum()),
            tris=int(sel.sum()),
            centroid=[round(float(x), 4) for x in c],
            bbox_min=[round(float(x), 4) for x in bmin],
            bbox_max=[round(float(x), 4) for x in bmax],
            normal=[round(float(x), 4) for x in mean_n],
            spread=round(spread, 1),
            radius=None if radius is None else round(radius, 4),
            axis=None if axis_pt is None else [round(float(x), 4) for x in axis],
            axis_pt=None if axis_pt is None else [round(float(x), 4) for x in axis_pt],
        ))
    return faces


def refine_labels(V, F, labels, nface, angle_deg=28.0, plane_deg=3.0,
                  cyl_axis_deg=3.0, cyl_r_tol=0.04):
    """Merge over-segmented clusters that belong to the same analytic surface."""
    n, area, cen = face_normals(V, F)
    faces = summarize(V, F, labels, nface, n, area, cen)
    info = {f['id']: f for f in faces}
    # cluster adjacency
    pairs = face_edges(labels, nface, F)
    parent = list(range(nface))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
            return True
        return False

    cp, cc = np.cos(np.deg2rad(plane_deg)), np.cos(np.deg2rad(cyl_axis_deg))
    changed = True
    while changed:
        changed = False
        for a, b in pairs:
            ia, ib = info.get(a), info.get(b)
            if not ia or not ib:
                continue
            if find(a) == find(b):
                continue
            if ia['type'] == ib['type'] == 'Plane':
                if abs(float(np.dot(ia['normal'], ib['normal']))) >= cp:
                    changed |= union(a, b)
            elif ia['type'] == ib['type'] == 'Cylinder':
                if ia['radius'] and ib['radius']:
                    r = max(ia['radius'], ib['radius'])
                    if abs(ia['radius'] - ib['radius']) / r > cyl_r_tol:
                        continue
                    if abs(float(np.dot(ia['axis'], ib['axis']))) < cc:
                        continue
                    # distance between axis lines
                    p1, p2 = np.array(ia['axis_pt']), np.array(ib['axis_pt'])
                    w = p2 - p1
                    d = np.linalg.norm(np.cross(w, ia['axis']))
                    if d / r < 0.06:
                        changed |= union(a, b)
    roots = [find(i) for i in range(nface)]
    uniq = sorted(set(roots))
    remap = {r: i for i, r in enumerate(uniq)}
    newlab = np.array([remap[r] for r in roots], dtype=np.int64)[labels]
    return newlab, len(uniq)


def face_edges(labels, nface, F):
    """gAAG edges: pairs of faces sharing a mesh edge."""
    edges = {}
    for ti, (i, j, k) in enumerate(F):
        for e in ((i, j), (j, k), (k, i)):
            key = (min(e), max(e))
            edges.setdefault(key, set()).add(int(labels[ti]))
    pairs = set()
    for ts in edges.values():
        if len(ts) == 2:
            a, b = sorted(ts)
            if a != b:
                pairs.add((a, b))
    return sorted(pairs)


def build(path, name, angle_deg=28.0, keep_faces=None):
    tris = read_ascii_stl(path)
    V, F = weld2(tris)
    labels, nface, n, area, cen = segment(V, F, angle_deg)
    labels, nface = refine_labels(V, F, labels, nface, angle_deg)
    bbox_min, bbox_max = V.min(axis=0), V.max(axis=0)
    scale = float(np.linalg.norm(bbox_max - bbox_min)) or 1.0
    origin = (bbox_min + bbox_max) / 2.0
    # centred, normalized positions
    Vn = (V - origin) / scale
    cen_n = (cen - origin) / scale
    faces = summarize(Vn, F, labels, nface, n, area / scale ** 2, cen_n)
    # recompute face stats in normalized space for consistency
    pos = Vn[F].astype(np.float32)               # (T,3,3)
    tricount = len(F)
    ids = [0] * tricount
    for f in faces:
        sel = labels == f['id']
        for ti in np.nonzero(sel)[0]:
            ids[int(ti)] = f['id']
    pairs = face_edges(labels, nface, F)
    raw_to_mm = 0.001 if scale > 3000 else 1.0
    inst = build_instances(Vn, F, labels, faces, pairs, scale, raw_to_mm)
    payload = dict(
        name=name,
        source=os.path.basename(path),
        triangles=tricount,
        faces=faces,
        instances=inst,
        edges=pairs,
        size_mm=[round(float(x) * raw_to_mm, 1) for x in (bbox_max - bbox_min)],
        bbox=[[round(float(x), 3) for x in bbox_min], [round(float(x), 3) for x in bbox_max]],
        positions_b64=base64.b64encode(np.ascontiguousarray(
            pos.reshape(-1), dtype=np.float32).tobytes()).decode('ascii'),
        faceids=ids,
    )
    return payload, faces


if __name__ == '__main__':
    parts = [
        ('partA.stl', 'AAGNet 示例件 A', 28.0),
        ('partB.stl', 'AAGNet 示例件 B', 28.0),
        ('partC.stl', 'AAGNet 示例件 C', 28.0),
    ]
    out = []
    missing = [fn for fn, _, _ in parts if not os.path.exists(os.path.join(SRC, fn))]
    if missing:
        sys.exit(
            'STL 样例未找到: %s\n当前样例目录: %s\n'
            '请把 AAGNet 官方仓库的 examples/ 放在与本仓库同级的位置，'
            '或设置环境变量 AAGNET_EXAMPLES 指向该目录。' % (', '.join(missing), SRC)
        )
    for fn, nm, ang in parts:
        p, faces = build(os.path.join(SRC, fn), nm, ang)
        out.append(p)
        owned = {}
        for it in p['instances']:
            for fid in it['faces']:
                owned.setdefault(fid, []).append(it['key'])
        dup = [k for k, v in owned.items() if len(v) > 1]
        print('==', nm, 'tris', p['triangles'], 'faces', len(faces),
              'instances', len(p['instances']), 'unclaimed', len(faces) - len(owned),
              'overlap', dup[:8])
        for it in p['instances']:
            print('   %-4s %-3s faces=%-24s conf=%.2f %s' %
                  (it['key'], it['cls'], str(it['faces'])[:24], it['conf'],
                   ' '.join('%s:%s' % (a, b) for a, b in it['params'])))
    js = 'window.AAG_DEMO=' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n'
    with open(os.path.join(ROOT, 'data.js'), 'w', encoding='utf-8') as fh:
        fh.write(js)
    with open(os.path.join(ROOT, 'data.json'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    print('data.js bytes:', os.path.getsize(os.path.join(ROOT, 'data.js')))
