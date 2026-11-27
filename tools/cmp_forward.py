# -*- coding: utf-8 -*-
"""逐阶段比对 JS 前向与 numpy 参考实现。

    python tools/cmp_forward.py tools/out/ph
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ref_forward as R  # noqa: E402


def cmp(tag, a, b):
    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    if a.size != b.size:
        print(f'{tag:16s} 尺寸不一致 {a.size} vs {b.size}')
        return
    d = np.abs(a - b)
    flag = 'OK ' if d.max() < 1e-4 else '!! '
    print(f'{tag:16s} {flag} maxabs={d.max():.6g}  mean={d.mean():.6g}  (js[-3:]={a[-3:]}, ref[-3:]={b[-3:]})')


def main():
    pre = sys.argv[1]
    meta = json.load(open(pre + '.meta.json'))
    js = json.load(open(pre + '.js.json'))
    N, E = meta['N'], meta['E']
    fa = np.fromfile(pre + '.fa.bin', dtype=np.float32).reshape(N, 10)
    ea = np.fromfile(pre + '.ea.bin', dtype=np.float32).reshape(E, 12)
    grid = np.fromfile(pre + '.grid.bin', dtype=np.float32).reshape(N, 7, 5, 5)
    edges = meta['edges']

    R.load_w()
    W = R.W

    ha = R.layer_norm(R.linear(fa, W['node_attr_encoder.0.weight'], W['node_attr_encoder.0.bias']),
                      W['node_attr_encoder.1.weight'], W['node_attr_encoder.1.bias'])
    hg = R.grid_encode(grid, N)
    he = R.layer_norm(R.linear(ea, W['edge_attr_encoder.0.weight'], W['edge_attr_encoder.0.bias']),
                      W['edge_attr_encoder.1.weight'], W['edge_attr_encoder.1.bias'])
    h0 = np.concatenate([ha, hg], axis=1)

    cmp('ha', js['dbg']['ha'], ha)
    cmp('hg', js['dbg']['hg'], hg)
    cmp('h0', js['dbg']['h0'], h0)
    cmp('he', js['dbg']['he'], he)

    h1 = R.node_mpnn_relu(h0, he, edges, 'graph_encoder.node_convs.0')
    cmp('after_layer0', js['dbg']['h1'], h1)
    h2 = R.node_mpnn_relu(h1, he, edges, 'graph_encoder.node_convs.1')
    h2 = R.node_mpnn_relu(h2, he, edges, 'graph_encoder.node_convs.1')
    cmp('after_layer2', js['dbg']['h3'], h2)

    local = R.layer_norm(h2, W['graph_encoder.post_norm.weight'], W['graph_encoder.post_norm.bias'])
    cmp('local', js['dbg']['local'], local)
    mean = local.mean(axis=0)
    cmp('mean', js['dbg']['mean'], mean)
    g = R.mlp(mean[None, :], [128, 128], 'graph_encoder.linear.',
              act=lambda v: np.maximum(v, 0), last_norm=True)
    cmp('global', js['dbg']['global'], g.ravel())

    lg = np.concatenate([local, np.repeat(g, N, axis=0)], axis=1)
    seg = R.mlp(lg, [256, 64, 25], 'seg_head.')
    cmp('seg', js['seg'], seg.ravel())
    bottom = R.mlp(lg, [256, 64, 1], 'bottom_head.')
    cmp('bottom', js['bottom'], bottom.ravel())
    q = R.mlp(lg, [256, 64, 64], 'inst_head.Wq.', last_norm=True)
    k = R.mlp(lg, [256, 64, 64], 'inst_head.Wk.', last_norm=True)
    cmp('inst', js['inst'], (q @ k.T).ravel())


if __name__ == '__main__':
    main()
