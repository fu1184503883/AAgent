# -*- coding: utf-8 -*-
"""Offline software rasterizer with clay shading + feature edges.

Usage:
  python tools/render_preview.py partA.stl iso top front
  python tools/render_preview.py partA.stl iso --hl 10,11 --name hl_holes
"""
import os, struct, sys, zlib
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import build_data as bd

SRC = bd.SRC  # 与 build_data.py 共用同一份样例目录解析逻辑
OUT = os.path.join(os.path.dirname(os.path.dirname(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)

CLAY = np.array([0.78, 0.80, 0.84])
HLC = np.array([1.0, 0.42, 0.15])


def write_png(path, img):
    h, w, _ = img.shape
    rgba = np.concatenate([img, np.full((h, w, 1), 255, np.uint8)], axis=2)
    raw = b"".join(b"\x00" + rgba[r].tobytes() for r in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def project(V, eye_dir, W, H, fov, dist, target):
    t = np.array(target, float)
    d = np.array(eye_dir, float); d /= np.linalg.norm(d)
    up = np.array([0, 0, 1.0])
    f = -d
    r = np.cross(f, up); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    eye = t + d * dist
    M = np.array([r, u, f])
    pts = (V - eye) @ M.T
    tanv = np.tan(np.deg2rad(fov) / 2)
    aspect = W / H
    z = pts[:, 2]
    sx = (pts[:, 0] / np.maximum(z, 1e-9)) / (tanv * aspect) * (W / 2) + W / 2
    sy = -(pts[:, 1] / np.maximum(z, 1e-9)) / tanv * (H / 2) + H / 2
    return sx, sy, z


_FONT = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '010', '010', '010', '010'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '001', '001', '001'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
}


def draw_ids(img, zbuf, cx, cy, cz, labels, sel_ids, scale=3, color=(255, 96, 32)):
    W = img.shape[1]; H = img.shape[0]
    for fid in sel_ids:
        ts = np.nonzero(labels == fid)[0]
        if len(ts) == 0:
            continue
        t = ts[np.argmin(cz[ts])]
        px = int(cx[t]); py = int(cy[t])
        if not (0 <= px < W and 0 <= py < H):
            continue
        if zbuf[py, px] < cz[t] * 0.98:
            continue
        txt = str(fid)
        w = len(txt) * 4 * scale
        x0, y0 = px - w // 2, py - 2 * scale
        for ci, ch in enumerate(txt):
            pat = _FONT.get(ch, _FONT['0'])
            for r, row in enumerate(pat):
                for c, bit in enumerate(row):
                    if bit == '1':
                        yy = y0 + r * scale; xx = x0 + ci * 4 * scale + c * scale
                        if 0 <= yy < H - scale and 0 <= xx < W - scale:
                            img[yy:yy + scale, xx:xx + scale] = color


def edge_mask(F, labels):
    """Triangles adjacency; return list of sharp/boundary edges as (vi,vj)."""
    emap = {}
    for ti, (i, j, k) in enumerate(F):
        for e in ((i, j), (j, k), (k, i)):
            key = (min(e), max(e))
            emap.setdefault(key, []).append(ti)
    n, area, cen = bd.face_normals(*_verts_cache)
    segs = []
    for key, ts in emap.items():
        if len(ts) == 1:
            segs.append(key); continue
        if labels[ts[0]] != labels[ts[1]]:
            segs.append(key); continue
        if abs(float(np.dot(n[ts[0]], n[ts[1]])) < 0.92):
            segs.append(key)
    return segs


def render(V, F, labels, segs, eye_dir, W=900, H=720, fov=30.0, dist=1.9,
           target=(0, 0, 0), hl=None, mode='clay', ids=False, class_col=None):
    sx, sy, z = project(V, eye_dir, W, H, fov, dist, target)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    nrm = np.cross(b - a, c - a)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    # two-sided lighting: flip every normal towards the camera
    d = np.array(eye_dir, float); d /= np.linalg.norm(d)
    view = -d
    flip = (nrm @ view) < 0
    nrm[flip] = -nrm[flip]
    img = np.zeros((H, W, 3))
    img[:] = np.array([20, 27, 40]) * 1.0
    zbuf = np.full((H, W), np.inf)
    L = (-d * 0.7 + np.array([0.0, 0.0, 0.55])); L /= np.linalg.norm(L)
    shade = 0.42 + 0.55 * np.clip(nrm @ L, 0, 1) + 0.14 * np.clip(nrm[:, 2], 0, 1)
    if class_col is not None:
        base = np.tile(np.array([0.36, 0.42, 0.50]), (len(F), 1))
        for fid, rgb in class_col.items():
            base[labels == fid] = rgb
    elif mode == 'palette':
        h = (labels * 0.61803398875) % 1.0
        k = np.stack([(h * 6 + n) % 6 for n in (5, 3, 1)], 1)

        def f(n):
            return 0.95 - 0.95 * 0.6 * np.clip(np.minimum(k[:, n % 3], 4 - k[:, n % 3]), 0, 1)
        base = np.stack([f(5), f(3), f(1)], 1)
    else:
        base = np.tile(CLAY, (len(F), 1))
        if hl:
            for fid in hl:
                base[labels == fid] = HLC
    cols = np.clip(base * shade[:, None] * 255, 0, 255)

    def raster_tri(xs, ys, zs, col):
        x0, x1 = int(np.floor(xs.min())), int(np.ceil(xs.max()))
        y0, y1 = int(np.floor(ys.min())), int(np.ceil(ys.max()))
        if x1 < 0 or y1 < 0 or x0 >= W or y0 >= H:
            return
        x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, W - 1); y1 = min(y1, H - 1)
        if x1 < x0 or y1 < y0:
            return
        X, Y = np.meshgrid(np.arange(x0, x1 + 1) + .5, np.arange(y0, y1 + 1) + .5)
        def ef(px, py, ax, ay, bx, by):
            return (px - ax) * (by - ay) - (py - ay) * (bx - ax)
        w0 = ef(X, Y, xs[0], ys[0], xs[1], ys[1])
        w1 = ef(X, Y, xs[1], ys[1], xs[2], ys[2])
        w2 = ef(X, Y, xs[2], ys[2], xs[0], ys[0])
        ar = ef(xs[0], ys[0], xs[1], ys[1], xs[2], ys[2])
        if abs(ar) < 1e-9:
            return
        sgn = np.sign(ar)
        inside = (w0 * sgn >= 0) & (w1 * sgn >= 0) & (w2 * sgn >= 0)
        if not inside.any():
            return
        zz = 1.0 / (w1 / ar / zs[0] + w2 / ar / zs[1] + w0 / ar / zs[2])
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        hit = inside & (zz < sub)
        sub[hit] = zz[hit]
        img[y0:y1 + 1, x0:x1 + 1][hit] = col

    for ti in range(len(F)):
        idx = F[ti]
        if not (z[idx] > 1e-6).all():
            continue
        raster_tri(sx[idx], sy[idx], z[idx], cols[ti])

    # edges
    for (vi, vj) in segs:
        if not (z[vi] > 1e-6 and z[vj] > 1e-6):
            continue
        p0 = np.array([sx[vi], sy[vi]]); p1 = np.array([sx[vj], sy[vj]])
        z0, z1 = z[vi] * 0.999, z[vj] * 0.999
        steps = int(max(abs(p1 - p0).max() * 1.5, 2))
        for s in range(steps + 1):
            tt = s / steps
            px, py = p0 * (1 - tt) + p1 * tt
            zz = 1.0 / ((1 - tt) / z0 + tt / z1)
            xi, yi = int(px), int(py)
            for dx in (0, 1):
                for dy in (0, 1):
                    if 0 <= xi + dx < W and 0 <= yi + dy < H and zz < zbuf[yi + dy, xi + dx]:
                        img[yi + dy, xi + dx] = np.array([12, 16, 24])
    img = np.clip(img, 0, 255).astype(np.uint8)
    if ids:
        cx = sx[F].mean(axis=1); cy = sy[F].mean(axis=1); cz = z[F].mean(axis=1)
        draw_ids(img, zbuf, cx, cy, cz, labels, list(range(labels.max() + 1)),
                 scale=3, color=(255, 96, 32))
    return img


_verts_cache = None

def main():
    args = sys.argv[1:]
    part = args[0] if args else 'partA.stl'
    views = [a for a in args[1:] if not a.startswith('--')] or ['iso', 'top', 'front', 'right']
    hl, name = None, part.replace('.stl', '')
    if '--hl' in args:
        hl = [int(x) for x in args[args.index('--hl') + 1].split(',')]
    if '--name' in args:
        name = args[args.index('--name') + 1]
    tris = bd.read_ascii_stl(os.path.join(SRC, part))
    V, F = bd.weld2(tris)
    labels, nf, n, area, cen = bd.segment(V, F, 28.0)
    bmin, bmax = V.min(0), V.max(0)
    scale = float(np.linalg.norm(bmax - bmin))
    V = (V - (bmin + bmax) / 2) / scale
    global _verts_cache
    _verts_cache = (V, F)
    segs = edge_mask(F, labels)
    dirs = {'iso': (0.75, -0.95, 0.62), 'top': (0.001, -0.001, 1.0),
            'front': (0.0, -1.0, 0.02), 'right': (1.0, 0.0, 0.02),
            'back': (0.0, 1.0, 0.02), 'bottom': (0.001, 0.001, -1.0)}
    views = [a for a in args[1:] if a in dirs] or ['iso']
    ids = '--ids' in args
    class_col = None
    if '--inst' in args:
        p, _ = bd.build(os.path.join(SRC, part), part, 28.0)
        pal = {'通孔': [0.22, 0.72, 0.98], '盲孔': [0.66, 0.55, 0.98],
               '型腔': [0.98, 0.74, 0.25], '槽': [0.20, 0.83, 0.60],
               '台阶': [0.38, 0.65, 0.96]}
        class_col = {}
        for it in p['instances']:
            for fid in it['faces']:
                class_col[fid] = pal[it['cls']]
    for v in views:
        img = render(V, F, labels, segs, dirs[v], dist=1.85, hl=hl, ids=ids,
                     class_col=class_col)
        p = os.path.join(OUT, '%s_%s.png' % (name, v))
        write_png(p, img)
        print('wrote', p, 'faces', nf, 'edges', len(segs))


if __name__ == '__main__':
    main()
