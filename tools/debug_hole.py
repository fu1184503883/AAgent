# -*- coding: utf-8 -*-
import sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import build_data as bd

V, F = bd.weld2(bd.read_ascii_stl(os.path.join(bd.SRC, 'partA.stl')))
labels, nf, n, area, cen = bd.segment(V, F, 28.0)
bmin, bmax = V.min(0), V.max(0)
scale = float(np.linalg.norm(bmax - bmin))
Vn = (V - (bmin + bmax) / 2) / scale
cen_n = (cen - (bmin + bmax) / 2) / scale
faces = bd.summarize(Vn, F, labels, nf, n, area / scale ** 2, cen_n)
pairs = bd.face_edges(labels, nf, F)
for f in faces:
    if f['type'] == 'Cylinder':
        sel = labels == f['id']
        pts = Vn[F[sel]].reshape(-1, 3)
        print('cyl', f['id'], 'r=', f['radius'], 'z', round(pts[:, 2].min(), 3), round(pts[:, 2].max(), 3),
              'xy', np.round(pts[:, :2].mean(0), 3), 'axis', f['axis'])
print('plates normal to z:')
for f in faces:
    if abs(f['normal'][2]) > 0.9:
        print(' plane', f['id'], 'z=', round(f['centroid'][2], 3), 'n=', f['normal'],
              'r_xy=', np.round(np.linalg.norm(np.array(f['centroid'][:2]) - np.array([0.0079, -0.1786])), 3),
              'bbox', np.round(np.array(f['bbox_min']), 2), np.round(np.array(f['bbox_max']), 2))
print('pairs with 10/11:', [(a, b) for a, b in pairs if a in (10, 11) or b in (10, 11)])
