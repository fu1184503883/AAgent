# -*- coding: utf-8 -*-
"""Parse ASCII STL, weld vertices, region-grow into B-Rep-like faces, report stats."""
import sys, json
import numpy as np

def read_ascii_stl(path):
    verts, tris = [], []
    with open(path, 'r', errors='ignore') as f:
        cur = []
        for line in f:
            s = line.strip()
            if s.startswith('vertex'):
                parts = s.split()
                cur.append((float(parts[1]), float(parts[2]), float(parts[3])))
                if len(cur) == 3:
                    tris.append(tuple(cur))
                    cur = []
    return np.array(tris, dtype=np.float64)  # (n,3,3)

def weld(tris, tol=1e-5):
    pts = tris.reshape(-1, 3)
    key = np.round(pts / tol).astype(np.int64)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    # map back to first-seen coordinates
    first = {}
    for i, k in enumerate(map(tuple, key)):
        if k not in first:
            first[k] = pts[i]
    V = np.array([first[tuple(k)] for k in uniq], dtype=np.float64)
    F = inv.reshape(-1, 3)
    return V, F

def face_normals(V, F):
    a = V[F[:, 0]]; b = V[F[:, 1]]; c = V[F[:, 2]]
    n = np.cross(b - a, c - a)
    area = np.linalg.norm(n, axis=1) * 0.5
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    cen = (a + b + c) / 3.0
    return n, area, cen

def build_adj(F):
    edges = {}
    for ti, (i, j, k) in enumerate(F):
        for e in ((i, j), (j, k), (k, i)):
            key = (min(e), max(e))
            edges.setdefault(key, []).append(ti)
    adj = [[] for _ in range(len(F))]
    for key, ts in edges.items():
        if len(ts) == 2:
            t0, t1 = ts
            adj[t0].append(t1); adj[t1].append(t0)
    return adj

def segment(V, F, angle_deg=25.0):
    n, area, cen = face_normals(V, F)
    adj = build_adj(F)
    cos_t = np.cos(np.deg2rad(angle_deg))
    labels = -np.ones(len(F), dtype=np.int64)
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

def summarize(V, F, labels, nface, n, area, cen):
    out = []
    for f in range(nface):
        sel = labels == f
        na = n[sel] * area[sel, None]
        w = area[sel]
        if w.sum() < 1e-12:
            continue
        mean_n = na.sum(axis=0) / w.sum()
        A = area[sel].sum()
        c = (cen[sel] * w[:, None]).sum(axis=0) / w.sum()
        vs = V[F[sel].reshape(-1)]
        bmin, bmax = vs.min(axis=0), vs.max(axis=0)
        # normal spread
        cosv = np.clip(n[sel] @ (mean_n / (np.linalg.norm(mean_n) + 1e-12)), -1, 1)
        spread = float(np.rad2deg(np.arccos(cosv.min()))) if cosv.size else 0.0
        cov = np.cov(n[sel].T) if sel.sum() > 3 else np.zeros((3, 3))
        evals, evecs = np.linalg.eigh(np.atleast_2d(cov))
        axis = evecs[:, 0]
        out.append(dict(
            id=int(f), area=float(A), centroid=[round(float(x), 4) for x in c],
            bbox_min=[round(float(x), 4) for x in bmin], bbox_max=[round(float(x), 4) for x in bmax],
            normal=[round(float(x), 4) for x in (mean_n / (np.linalg.norm(mean_n) + 1e-12))],
            normal_spread=round(spread, 2), tris=int(sel.sum()), axis=[round(float(x), 4) for x in axis],
        ))
    return out

if __name__ == '__main__':
    path = sys.argv[1]; ang = float(sys.argv[2]) if len(sys.argv) > 2 else 25.0
    tris = read_ascii_stl(path)
    V, F = weld(tris)
    labels, nf, n, area, cen = segment(V, F, ang)
    info = dict(file=path.split('\\')[-1], triangles=int(len(F)), vertices=int(len(V)),
                faces=int(nf), bbox_min=[round(float(x), 3) for x in V.min(axis=0)],
                bbox_max=[round(float(x), 3) for x in V.max(axis=0)],
                faces_detail=summarize(V, F, labels, nf, n, area, cen))
    print(json.dumps(info, ensure_ascii=False, indent=1)[:2000])
    print('...')
    print('faces:', nf, 'tris:', len(F))
