# -*- coding: utf-8 -*-
"""生成用于自检的 STEP(AP214) 样例件。

只为了给 step_import.js 做回归测试：手写最小 B-Rep 拓扑（顶点 / 边 / 环 / 面），
几何是精确的平面 + 圆柱，便于核对面数、实例数、孔径深度。

    python tools/make_test_step.py            # 写到 tools/samples/
"""
import math
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'samples')
Z = [0.0, 0.0, 1.0]
X = [1.0, 0.0, 0.0]


def fmt(x):
    s = ('%.6f' % x).rstrip('0')
    return s + '0' if s.endswith('.') else s


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


class Doc(object):
    def __init__(self):
        self.n = 0
        self.lines = []
        self.vcache, self.pcache, self.ecache = {}, {}, {}
        self.einfo = {}          # edge id -> (起点, 终点)，用于判定 ORIENTED_EDGE 方向

    def add(self, body):
        self.n += 1
        self.lines.append('#%d=%s;' % (self.n, body))
        return self.n

    def point(self, p):
        key = tuple(round(c, 6) for c in p)
        if key not in self.pcache:
            self.pcache[key] = self.add("CARTESIAN_POINT('',(%s))" % ','.join(fmt(c) for c in p))
        return self.pcache[key]

    def dir(self, d):
        return self.add("DIRECTION('',(%s))" % ','.join(fmt(c) for c in d))

    def axis2(self, o, z, x):
        return self.add("AXIS2_PLACEMENT_3D('',#%d,#%d,#%d)" % (self.point(o), self.dir(z), self.dir(x)))

    def vertex(self, p):
        key = tuple(round(c, 6) for c in p)
        if key not in self.vcache:
            self.vcache[key] = self.add("VERTEX_POINT('',#%d)" % self.point(p))
        return self.vcache[key]

    # ---------------- edges ----------------
    def line_edge(self, p1, p2):
        k = 'L|' + ','.join('%.6f' % c for c in p1) + '|' + ','.join('%.6f' % c for c in p2)
        k2 = 'L|' + ','.join('%.6f' % c for c in p2) + '|' + ','.join('%.6f' % c for c in p1)
        for key in (k, k2):
            if key in self.ecache:
                return self.ecache[key]
        v1, v2 = self.vertex(p1), self.vertex(p2)
        d = [p2[i] - p1[i] for i in range(3)]
        ln = math.sqrt(sum(c * c for c in d)) or 1.0
        vec = self.add("VECTOR('',#%d,1.0)" % self.dir([c / ln for c in d]))
        crv = self.add("LINE('',#%d,#%d)" % (self.point(p1), vec))
        i = self.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)" % (v1, v2, crv))
        self.ecache[k] = i
        self.einfo[i] = (tuple(p1), tuple(p2))
        return i

    def circle_edge(self, center, normal, xdir, r):
        k = 'C|' + ','.join('%.6f' % c for c in center) + '|' + ','.join('%.6f' % c for c in normal) + '|%.6f' % r
        if k in self.ecache:
            return self.ecache[k]
        p0 = [center[i] + xdir[i] * r for i in range(3)]
        v = self.vertex(p0)
        crv = self.add("CIRCLE('',#%d,%s)" % (self.axis2(center, normal, xdir), fmt(r)))
        i = self.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)" % (v, v, crv))
        self.ecache[k] = i
        self.einfo[i] = (tuple(p0), tuple(p0))
        return i

    def arc_edge(self, center, normal, xdir, r, a0, a1):
        """圆弧边：从角度 a0 逆时针到 a1。"""
        k = 'A|' + ','.join('%.6f' % c for c in center) + '|%.6f|%.6f|%.6f' % (r, a0, a1)
        if k in self.ecache:
            return self.ecache[k]
        ydir = cross(normal, xdir)
        p0 = [center[i] + (xdir[i] * math.cos(a0) + ydir[i] * math.sin(a0)) * r for i in range(3)]
        p1 = [center[i] + (xdir[i] * math.cos(a1) + ydir[i] * math.sin(a1)) * r for i in range(3)]
        crv = self.add("CIRCLE('',#%d,%s)" % (self.axis2(center, normal, xdir), fmt(r)))
        i = self.add("EDGE_CURVE('',#%d,#%d,#%d,.T.)" % (self.vertex(p0), self.vertex(p1), crv))
        self.ecache[k] = i
        self.einfo[i] = (tuple(p0), tuple(p1))
        return i


def loop_chain(doc, edges, starts):
    """按给定遍历起点拼闭合环，方向（.T./.F.）由边自身起止点推断。"""
    refs = []
    for e, s in zip(edges, starts):
        fwd = dist(doc.einfo[e][0], s) < 1e-6
        refs.append(doc.add("ORIENTED_EDGE('',*,*,#%d,%s)" % (e, '.T.' if fwd else '.F.')))
    return doc.add("EDGE_LOOP('',(%s))" % ','.join('#%d' % i for i in refs))


def line_loop(doc, pts):
    n = len(pts)
    edges = [doc.line_edge(pts[i], pts[(i + 1) % n]) for i in range(n)]
    return loop_chain(doc, edges, pts)


def face(doc, surface, loops, orient='T'):
    """orient='F' 表示面法向与曲面自然法向相反 —— 孔壁 / 缺口壁必须是 'F'，
    否则法向会指进材料里，凸凹和体积都会算错。"""
    if surface[0] == 'plane':
        _, o, n, x = surface
        surf = doc.add("PLANE('',#%d)" % doc.axis2(o, n, x))
    else:
        _, o, n, x, r = surface
        surf = doc.add("CYLINDRICAL_SURFACE('',#%d,%s)" % (doc.axis2(o, n, x), fmt(r)))
    bounds = [doc.add("%s('',#%d,.T.)" % ('FACE_OUTER_BOUND' if i == 0 else 'FACE_BOUND', lp))
              for i, lp in enumerate(loops)]
    return doc.add("ADVANCED_FACE('',(%s),#%d,.%s.)" % (','.join('#%d' % b for b in bounds), surf, orient))


def wrap(doc, faces):
    head = ["ISO-10303-21;", "HEADER;",
            "FILE_DESCRIPTION((''),'2;1');",
            "FILE_NAME('x','2026-01-01T00:00:00',(''),(''),'','','');",
            "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
            "ENDSEC;", "DATA;"]
    tail = ["ENDSEC;", "END-ISO-10303-21;"]
    unit = doc.add("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")
    um = doc.add("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-6),#%d,'','')" % unit)
    ctx = doc.add("(GEOMETRIC_REPRESENTATION_CONTEXT(3)"
                  "GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#%d))"
                  "GLOBAL_UNIT_ASSIGNED_CONTEXT((#%d))"
                  "REPRESENTATION_CONTEXT('',''))" % (um, unit))
    shell = doc.add("CLOSED_SHELL('',(%s))" % ','.join('#%d' % f for f in faces))
    brep = doc.add("MANIFOLD_SOLID_BREP('',#%d)" % shell)
    rep = doc.add("ADVANCED_BREP_SHAPE_REPRESENTATION('',(#%d),#%d)" % (brep, ctx))
    ac = doc.add("APPLICATION_CONTEXT('automotive design')")
    pctx = doc.add("PRODUCT_CONTEXT('',#%d,'mechanical')" % ac)
    prod = doc.add("PRODUCT('part','part','',(#%d))" % pctx)
    pdf = doc.add("PRODUCT_DEFINITION_FORMATION('','',#%d)" % prod)
    apd = doc.add("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#%d)" % ac)
    pdc = doc.add("PRODUCT_DEFINITION_CONTEXT('part definition',#%d,'design')" % apd)
    pd = doc.add("PRODUCT_DEFINITION('design','',#%d,#%d)" % (pdf, pdc))
    pds = doc.add("PRODUCT_DEFINITION_SHAPE('','',#%d)" % pd)
    doc.add("SHAPE_DEFINITION_REPRESENTATION(#%d,#%d)" % (pds, rep))
    return '\n'.join(head + doc.lines + tail)


def _side_faces(d, x, y, dz, n0=[0, -1, 0]):
    quads = [([0, -1, 0], [[-x, -y, 0], [x, -y, 0], [x, -y, dz], [-x, -y, dz]]),
             ([1, 0, 0], [[x, -y, 0], [x, y, 0], [x, y, dz], [x, -y, dz]]),
             ([0, 1, 0], [[x, y, 0], [-x, y, 0], [-x, y, dz], [x, y, dz]]),
             ([-1, 0, 0], [[-x, y, 0], [-x, -y, 0], [-x, -y, dz], [-x, y, dz]])]
    return [face(d, ('plane', pts[0], n, [0, 0, 1]), [line_loop(d, pts)]) for n, pts in quads]


# ---------------------------------------------------------------- parts
def box_plate(dx=60.0, dy=40.0, dz=10.0):
    d = Doc()
    x, y = dx / 2.0, dy / 2.0
    b = [[-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0]]
    t = [[-x, -y, dz], [x, -y, dz], [x, y, dz], [-x, y, dz]]
    fs = [face(d, ('plane', b[0], [0, 0, -1], X), [line_loop(d, b)]),
          face(d, ('plane', t[0], Z, X), [line_loop(d, t)])]
    fs += _side_faces(d, x, y, dz)
    return wrap(d, fs)


def plate_hole(dx=60.0, dy=40.0, dz=10.0, r=6.0):
    d = Doc()
    x, y = dx / 2.0, dy / 2.0
    top = lambda z: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]
    fs = [face(d, ('plane', [0, 0, 0], [0, 0, -1], X),
               [line_loop(d, top(0)),
                loop_chain(d, [d.circle_edge([0, 0, 0], [0, 0, -1], X, r)], [[-r, 0, 0]])]),
          face(d, ('plane', [-x, -y, dz], Z, X),
               [line_loop(d, top(dz)),
                loop_chain(d, [d.circle_edge([0, 0, dz], Z, X, r)], [[r, 0, dz]])])]
    fs += _side_faces(d, x, y, dz)
    c0 = d.circle_edge([0, 0, 0], Z, X, r)
    c1 = d.circle_edge([0, 0, dz], Z, X, r)
    s1 = d.line_edge([r, 0, 0], [r, 0, dz])
    s2 = d.line_edge([r, 0, dz], [r, 0, 0])
    fs.append(face(d, ('cyl', [0, 0, 0], Z, X, r),
                   [loop_chain(d, [c0, s1, c1, s2], [[-r, 0, 0], [r, 0, 0], [r, 0, dz], [-r, 0, dz]])],
                   orient='F'))
    return wrap(d, fs)


def plate_pocket(dx=60.0, dy=40.0, dz=12.0, px=30.0, py=16.0, pdepth=6.0):
    d = Doc()
    x, y = dx / 2.0, dy / 2.0
    a, b = px / 2.0, py / 2.0
    zf = dz - pdepth
    rect = lambda z, hx, hy: [[-hx, -hy, z], [hx, -hy, z], [hx, hy, z], [-hx, hy, z]]
    fs = [face(d, ('plane', [-x, -y, 0], [0, 0, -1], X), [line_loop(d, rect(0, x, y))]),
          face(d, ('plane', [-x, -y, dz], Z, X),
               [line_loop(d, rect(dz, x, y)), line_loop(d, rect(dz, a, b))])]
    fs += _side_faces(d, x, y, dz)
    fs.append(face(d, ('plane', [-a, -b, zf], Z, X), [line_loop(d, rect(zf, a, b))]))
    walls = [([0, 1, 0], [[-a, -b, zf], [a, -b, zf], [a, -b, dz], [-a, -b, dz]]),
             ([-1, 0, 0], [[a, -b, zf], [a, b, zf], [a, b, dz], [a, -b, dz]]),
             ([0, -1, 0], [[a, b, zf], [-a, b, zf], [-a, b, dz], [a, b, dz]]),
             ([1, 0, 0], [[-a, b, zf], [-a, -b, zf], [-a, -b, dz], [-a, b, dz]])]
    for n, pts in walls:
        fs.append(face(d, ('plane', pts[0], n, [0, 0, 1]), [line_loop(d, pts)]))
    return wrap(d, fs)


def plate_notch(dx=60.0, dy=40.0, dz=10.0, r=8.0):
    """+Y 边上的半圆缺口：180° 圆柱面 + 上下两段圆弧边。"""
    d = Doc()
    x, y = dx / 2.0, dy / 2.0
    a0, a1 = math.pi, 2 * math.pi            # (-r,y) → 内侧 → (r,y)
    arc_b = d.arc_edge([0, y, 0], Z, X, r, a0, a1)
    arc_t = d.arc_edge([0, y, dz], Z, X, r, a0, a1)
    seamR = d.line_edge([r, y, 0], [r, y, dz])
    seamL = d.line_edge([-r, y, dz], [-r, y, 0])

    def outer(z):
        arc = arc_b if z == 0 else arc_t
        edges = [d.line_edge([-x, -y, z], [x, -y, z]),
                 d.line_edge([x, -y, z], [x, y, z]),
                 d.line_edge([x, y, z], [r, y, z]),
                 arc,
                 d.line_edge([-r, y, z], [-x, y, z]),
                 d.line_edge([-x, y, z], [-x, -y, z])]
        starts = [[-x, -y, z], [x, -y, z], [x, y, z], [r, y, z], [-r, y, z], [-x, y, z]]
        return loop_chain(d, edges, starts)

    fs = [face(d, ('plane', [-x, -y, 0], [0, 0, -1], X), [outer(0)]),
          face(d, ('plane', [-x, -y, dz], Z, X), [outer(dz)])]
    for n, pts in [([0, -1, 0], [[-x, -y, 0], [x, -y, 0], [x, -y, dz], [-x, -y, dz]]),
                   ([1, 0, 0], [[x, -y, 0], [x, y, 0], [x, y, dz], [x, -y, dz]]),
                   ([-1, 0, 0], [[-x, y, 0], [-x, -y, 0], [-x, -y, dz], [-x, y, dz]]),
                   ([0, 1, 0], [[-x, y, 0], [-r, y, 0], [-r, y, dz], [-x, y, dz]]),
                   ([0, 1, 0], [[r, y, 0], [x, y, 0], [x, y, dz], [r, y, dz]])]:
        fs.append(face(d, ('plane', pts[0], n, [0, 0, 1]), [line_loop(d, pts)]))
    fs.append(face(d, ('cyl', [0, y, 0], Z, X, r),
                   [loop_chain(d, [arc_b, seamR, arc_t, seamL],
                               [[-r, y, 0], [r, y, 0], [r, y, dz], [-r, y, dz]])],
                   orient='F'))
    return wrap(d, fs)


def plate_blind(dx=60.0, dy=40.0, dz=12.0, r=5.0, depth=6.0):
    """盲孔：自顶面向下 depth，孔底是平面（单环）——用来验证 通孔 / 盲孔 的区分。"""
    d = Doc()
    x, y = dx / 2.0, dy / 2.0
    zf = dz - depth
    top = lambda z: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]
    fs = [face(d, ('plane', [-x, -y, 0], [0, 0, -1], X), [line_loop(d, top(0))]),
          face(d, ('plane', [-x, -y, dz], Z, X),
               [line_loop(d, top(dz)),
                loop_chain(d, [d.circle_edge([0, 0, dz], Z, X, r)], [[r, 0, dz]])])]
    fs += _side_faces(d, x, y, dz)
    # 孔底：单环平面，法线朝 +Z（指向孔内空腔）
    fs.append(face(d, ('plane', [0, 0, zf], Z, X),
                   [loop_chain(d, [d.circle_edge([0, 0, zf], Z, X, r)], [[r, 0, zf]])]))
    c0 = d.circle_edge([0, 0, zf], Z, X, r)
    c1 = d.circle_edge([0, 0, dz], Z, X, r)
    s1 = d.line_edge([r, 0, zf], [r, 0, dz])
    s2 = d.line_edge([r, 0, dz], [r, 0, zf])
    fs.append(face(d, ('cyl', [0, 0, 0], Z, X, r),
                   [loop_chain(d, [c0, s1, c1, s2],
                               [[-r, 0, zf], [r, 0, zf], [r, 0, dz], [-r, 0, dz]])],
                   orient='F'))
    return wrap(d, fs)


if __name__ == '__main__':
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    todo = [('box.step', box_plate()), ('plate_hole.step', plate_hole()),
            ('plate_pocket.step', plate_pocket()), ('plate_notch.step', plate_notch()),
            ('plate_blind.step', plate_blind())]
    for name, text in todo:
        with open(os.path.join(OUT, name), 'w', encoding='ascii') as fh:
            fh.write(text + '\n')
        print('%-20s %6.1f KB' % (name, os.path.getsize(os.path.join(OUT, name)) / 1024.0))
