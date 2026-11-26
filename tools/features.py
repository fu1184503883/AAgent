# -*- coding: utf-8 -*-
"""Rule-based feature assembly used by the demo data builder.

NOTE: this is a *demo-side* geometry heuristic (holes from coaxial cylinders,
recesses from upturned planes plus their rising walls). It is NOT the output of
the AAGNet network; the demo page states this explicitly.
"""
import numpy as np

UP = np.array([0.0, 0.0, 1.0])
MM = 1000.0  # default source unit: micrometres


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def shared_lengths(V, F, labels, pairs):
    """Length of the boundary shared by every pair of touching faces."""
    emap = {}
    for ti, tri in enumerate(F):
        for e in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            key = (min(e), max(e))
            emap.setdefault(key, []).append(ti)
    out = {}
    for key, ts in emap.items():
        if len(ts) == 2 and labels[ts[0]] != labels[ts[1]]:
            a, b = sorted((int(labels[ts[0]]), int(labels[ts[1]])))
            out[(a, b)] = out.get((a, b), 0.0) + float(np.linalg.norm(V[key[0]] - V[key[1]]))
    return out


def build_instances(V, F, labels, faces, pairs, scale, raw_to_mm=0.001):
    by_id = {f['id']: f for f in faces}
    to_mm = scale * raw_to_mm
    inst = []

    # ---------------------------------------------------------------- holes
    cyls = [f for f in faces if f['type'] == 'Cylinder']
    groups = []
    for f in cyls:
        for g in groups:
            a = g[0]
            if abs(a['radius'] - f['radius']) / max(a['radius'], f['radius']) > 0.05:
                continue
            if abs(float(np.dot(a['axis'], f['axis']))) < 0.97:
                continue
            d = np.linalg.norm(np.cross(np.array(f['axis_pt']) - np.array(a['axis_pt']), a['axis']))
            if d / max(a['radius'], 1e-9) > 0.12:
                continue
            g.append(f)
            break
        else:
            groups.append([f])

    for gi, g in enumerate(groups):
        r = float(np.mean([f['radius'] for f in g]))
        ax = unit(np.mean([f['axis'] for f in g], axis=0))
        ids = [f['id'] for f in g]
        pts = V[F[np.isin(labels, ids)]].reshape(-1, 3)
        proj = pts @ ax
        h0, h1 = float(proj.min()), float(proj.max())
        base = np.array(g[0]['axis_pt'])
        caps = []
        for a, b in pairs:
            if a in ids or b in ids:
                other = b if a in ids else a
                fb = by_id[other]
                if fb['type'] != 'Plane' or abs(float(np.dot(fb['normal'], ax))) < 0.9:
                    continue
                rel = float(np.dot(np.array(fb['centroid']) - base, ax))
                if h0 - 1e-3 <= rel <= h1 + 1e-3:
                    xy = np.linalg.norm(np.array(fb['centroid'][:2]) - np.array(g[0]['centroid'][:2]))
                    if xy < r * 2.2:
                        caps.append(other)
        caps = sorted(set(caps))
        cls = '通孔' if len(caps) >= 2 else '盲孔'
        bottom = caps[0] if (cls == '盲孔' and caps) else None
        depth = (h1 - h0) * to_mm
        c = np.mean([f['centroid'] for f in g], axis=0)
        params = [['直径', 'Φ%.1f mm' % (2 * r * to_mm)],
                  ['深度' if cls == '盲孔' else '壁厚', '%.1f mm' % depth],
                  ['位置', 'X%.1f  Y%.1f' % (c[0] * to_mm, c[1] * to_mm)]]
        inst.append(dict(
            key='H%d' % (gi + 1), cls=cls, faces=ids, bottom=bottom,
            conf=0.97 if cls == '通孔' else 0.95,
            params=params, depth_mm=depth, dia_mm=2 * r * to_mm,
        ))

    # -------------------------------------------------------------- recesses
    top_z = float(np.max(V[:, 2]))
    part_min, part_max = V.min(axis=0), V.max(axis=0)
    part_ext = np.maximum(part_max - part_min, 1e-9)
    edge_len = shared_lengths(V, F, labels, pairs)
    cands = []
    for f in faces:
        if f['type'] != 'Plane':
            continue
        if float(np.dot(np.array(f['normal']), UP)) < 0.75:
            continue
        zc = f['centroid'][2]
        if zc > top_z - 0.02:
            continue
        walls = []
        for a, b in pairs:
            if a == f['id'] or b == f['id']:
                other = b if a == f['id'] else a
                fb = by_id[other]
                # a wall must rise from the recess floor, not span the whole part
                if fb['centroid'][2] - zc <= 0.012:
                    continue
                if abs(float(np.dot(fb['normal'], UP))) >= 0.6:
                    continue
                if fb['bbox_min'][2] < zc - 0.02:
                    continue
                walls.append(other)
        if walls:
            cands.append(dict(bottom=f['id'], walls=walls,
                              area=by_id[f['id']]['area']))

    # each wall goes to the recess bottom it shares the longest boundary with
    claims = {}
    for ci, c in enumerate(cands):
        for w in c['walls']:
            L = edge_len.get(tuple(sorted((c['bottom'], w))), 0.0)
            if w not in claims or L > claims[w][1]:
                claims[w] = (ci, L)
    for ci, c in enumerate(cands):
        c['assigned'] = [w for w, (k, _) in claims.items() if k == ci]

    for c in cands:
        f = by_id[c['bottom']]
        bmin = np.array(f.get('bbox_min', [0, 0, 0]))
        bmax = np.array(f.get('bbox_max', [0, 0, 0]))
        ext = np.abs(bmax - bmin) * to_mm
        long_side = float(max(ext[0], ext[1]))
        short_side = float(min(ext[0], ext[1]))
        depth = (top_z - f['centroid'][2]) * to_mm
        # direction histogram of the rising walls
        dirs = set()
        for w in c['assigned']:
            d = np.array(by_id[w]['centroid'][:2]) - np.array(f['centroid'][:2])
            if np.linalg.norm(d) < 1e-9:
                continue
            d /= np.linalg.norm(d)
            dirs.add((round(float(d[0]), 1), round(float(d[1]), 1)))
        span = np.abs(bmax - bmin)
        rxy = [span[0] / part_ext[0], span[1] / part_ext[1]]
        depth_n = top_z - f['centroid'][2]
        if min(rxy) > 0.78 and depth_n < 0.55 * (part_max[2] - part_min[2]):
            cls = '台阶'          # whole-part level: a milled step, not a cavity
        elif len(dirs) >= 3:
            cls = '型腔'
        elif len(c['assigned']) >= 2 and (long_side > 2.0 * max(short_side, 1e-6)):
            cls = '槽'
        else:
            cls = '台阶'
        inst.append(dict(
            key='R%d' % f['id'], cls=cls,
            faces=[f['id']] + c['assigned'], bottom=f['id'],
            conf=0.93 if cls == '型腔' else 0.91,
            params=[['宽', '%.1f mm' % short_side],
                    ['长', '%.1f mm' % long_side],
                    ['深', '%.1f mm' % depth]],
            depth_mm=depth, dia_mm=None,
        ))

    for i, it in enumerate(inst):
        it['id'] = i
        it['faces'] = sorted(set(int(x) for x in it['faces']))
        if it['bottom'] is not None:
            it['bottom'] = int(it['bottom'])
    return inst
