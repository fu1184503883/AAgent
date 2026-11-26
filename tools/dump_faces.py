# -*- coding: utf-8 -*-
"""Dump only face statistics of a sampled part for manual inspection."""
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import build_data as bd

path = sys.argv[1]
tris = bd.read_ascii_stl(path)
V, F = bd.weld2(tris)
labels, nface, n, area, cen = bd.segment(V, F, 28.0)
bmin, bmax = V.min(axis=0), V.max(axis=0)
scale = float(((bmax - bmin) ** 2).sum() ** 0.5)
origin = (bmin + bmax) / 2
Vn = (V - origin) / scale
cen_n = (cen - origin) / scale
faces = bd.summarize(Vn, F, labels, nface, n, area / scale ** 2, cen_n)
ext = (bmax - bmin)
print('bbox_extent(mm):', [round(float(x), 2) for x in ext], 'scale', round(scale, 2))
for f in sorted(faces, key=lambda x: x['id']):
    print('id=%-3d %-13s area=%-7.4f n=%-4d normal=%s c=%s r=%s axis_pt=%s' % (
        f['id'], f['type'], f['area'], f['tris'],
        [round(v, 2) for v in f['normal']],
        [round(v, 2) for v in f['centroid']],
        f['radius'], f['axis_pt']))
print('edges:', len(bd.face_edges(labels, nface, F)))
