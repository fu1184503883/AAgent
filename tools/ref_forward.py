# -*- coding: utf-8 -*-
"""AAGNet 的 numpy 参考前向（交叉验证用）。

严格按 AAGNet-main/models 的 PyTorch 模块手写，不依赖 torch / dgl：

    node_attr_encoder : Linear(10,64) + LayerNorm(64)
    node_grid_encoder : Conv2d(7,16,3,p1)+BN+Mish / Conv2d(16,32)+BN+Mish / Conv2d(32,64)+BN+Mish + GAP
    edge_attr_encoder : Linear(12,64) + LayerNorm(64)
    graph_encoder     : AAGNetGraphEncoder(num_layers=3, conv_on_edge=False)
                        node_convs[0] 一次 + node_convs[1] 两次（共享权重）
                        NodeMPNN = res1*Scale + Scale(DropPath(PNAConvTower(norm1)))
                                 + res2*Scale + Scale(DropPath(mlp(norm2)))
    seg/bottom/inst   : MLP(2, 256, 64, ...) ，LayerNorm 在隐层、Mish 激活
    graph.linear      : MLP(1,128,0,128, nn.LayerNorm, last_norm=True)

用法:
    python tools/ref_forward.py <dump前缀> [--dump-json]
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pth2js import load_state_dict  # noqa: E402

PTH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', '..', 'Tecwin', 'AAGNet-main', 'weights', 'weight_on_MFInstseg.pth')
PTH_FALLBACK = r'C:/Users/kenven/Desktop/Tecwin/AAGNet-main/weights/weight_on_MFInstseg.pth'

W = None


def load_w(path=None):
    global W
    p = path or (PTH if os.path.exists(PTH) else PTH_FALLBACK)
    sd = load_state_dict(p)
    W = {k: v.astype(np.float32) for k, v in sd.items() if isinstance(v, np.ndarray)}
    return W


# ------------------------------------------------------------------ 基础算子
def mish(x):
    return x * np.tanh(np.log1p(np.exp(-np.abs(x))) + np.maximum(x, 0))
    # = x*tanh(softplus(x))，数值稳定写法


def linear(x, w, b=None):
    y = x @ w.T
    if b is not None:
        y = y + b
    return y


def layer_norm(x, w, b, eps=1e-5):
    mu = x.mean(axis=-1, keepdims=True)
    var = x.var(axis=-1, keepdims=True)
    return (x - mu) / np.sqrt(var + eps) * w + b


def batch_norm1d(x, p, eps=1e-5):
    g, b = W[p + '.weight'], W[p + '.bias']
    mu, var = W[p + '.running_mean'], W[p + '.running_var']
    return (x - mu) / np.sqrt(var + eps) * g + b


def batch_norm2d(x, p, eps=1e-5):
    # x: (C,H,W)
    g, b = W[p + '.weight'], W[p + '.bias']
    mu, var = W[p + '.running_mean'], W[p + '.running_var']
    sh = (x.shape[0],) + (1,) * (x.ndim - 1)
    return (x - mu.reshape(sh)) / np.sqrt(var.reshape(sh) + eps) * g.reshape(sh) + b.reshape(sh)


def mlp(x, dims, prefix, act=mish, last_norm=False):
    """对齐 models/layers.py: MLP.forward
    - num_layers==1 → self.linear（键名 linear.weight）
    - 否则 linears.i（隐层无 bias）+ norms.i + act，最后一层有 bias、无 norm
    """
    n = len(dims)
    if n == 2:
        out = linear(x, W[prefix + 'linear.weight'], W.get(prefix + 'linear.bias'))
        return layer_norm(out, W[prefix + 'post_norm.weight'], W[prefix + 'post_norm.bias']) if last_norm else out
    h = x
    for i in range(n - 2):
        h = linear(h, W[prefix + 'linears.%d.weight' % i],
                   W.get(prefix + 'linears.%d.bias' % i))
        h = layer_norm(h, W[prefix + 'norms.%d.weight' % i], W[prefix + 'norms.%d.bias' % i])
        h = act(h)
    h = linear(h, W[prefix + 'linears.%d.weight' % (n - 2)],
               W.get(prefix + 'linears.%d.bias' % (n - 2)))
    if last_norm:
        h = layer_norm(h, W[prefix + 'post_norm.weight'], W[prefix + 'post_norm.bias'])
    return h


# ------------------------------------------------------------------ 网格编码
def conv3x3(x, p):
    """x: (C,H,W) padding=1 stride=1"""
    w, b = W[p + '.weight'], W[p + '.bias']
    C, H, Wd = x.shape
    xp = np.pad(x, ((0, 0), (1, 1), (1, 1)))
    out = np.zeros((w.shape[0], H, Wd), dtype=np.float32)
    for ky in range(3):
        for kx in range(3):
            patch = xp[:, ky:ky + H, kx:kx + Wd]
            out += np.einsum('oc,chw->ohw', w[:, :, ky, kx], patch)
    return out + b.reshape(-1, 1, 1)


def grid_encode(grid, N):
    # grid: (N, 7, 5, 5)
    out = np.zeros((N, 64), dtype=np.float32)
    for i in range(N):
        s = grid[i]
        s = mish(batch_norm2d(conv3x3(s, 'node_grid_encoder.0'), 'node_grid_encoder.1'))
        s = mish(batch_norm2d(conv3x3(s, 'node_grid_encoder.3'), 'node_grid_encoder.4'))
        s = mish(batch_norm2d(conv3x3(s, 'node_grid_encoder.6'), 'node_grid_encoder.7'))
        out[i] = s.mean(axis=(1, 2))
    return out


# ------------------------------------------------------------------ PNA / MPNN
def pna_conv(x, he, edges, prefix):
    """models/pnaconv.py: PNAConvTower.forward
    msg = M·[h_src; h_dst; a_e]
    h_neigh = [sum_e msg ; max_e msg]
    out = U·[x ; h_neigh] * sqrt(1/N)，再过 BN
    """
    N = x.shape[0]
    D = x.shape[1]
    M, Mb = W[prefix + '.conv.M.weight'], W[prefix + '.conv.M.bias']
    U, Ub = W[prefix + '.conv.U.weight'], W[prefix + '.conv.U.bias']
    src = np.array([e[0] for e in edges], dtype=np.int64)
    dst = np.array([e[1] for e in edges], dtype=np.int64)
    f = np.concatenate([x[src], x[dst], he], axis=1)          # (E, 320)
    msg = f @ M.T + Mb                                        # (E, 128)
    sm = np.zeros((N, D), dtype=np.float32)
    mx = np.full((N, D), -np.inf, dtype=np.float32)
    np.add.at(sm, dst, msg)
    np.maximum.at(mx, dst, msg)
    mx[~np.isfinite(mx)] = 0.0                                # 无入边节点：DGL 的空 mailbox
    uin = np.concatenate([x, sm, mx], axis=1)                 # (N, 384)
    h = (uin @ U.T + Ub) * np.sqrt(1.0 / N)
    return batch_norm1d(h, prefix + '.conv.norm_drop.0')


def node_mpnn(h, he, edges, prefix):
    x = layer_norm(h, W[prefix + '.norm1.weight'], W[prefix + '.norm1.bias'])
    x = pna_conv(x, he, edges, prefix)
    h = h * W[prefix + '.res_scale1.scale'] + x * W[prefix + '.layer_scale1.scale']
    y = layer_norm(h, W[prefix + '.norm2.weight'], W[prefix + '.norm2.bias'])
    y = mlp(y, [128, 256, 128], prefix + '.mlp.')
    # 注意：MLP(2, 128, 256, 128, nn.LayerNorm, nn.Mish) 是位置传参，
    # last_norm 收到 nn.Mish（truthy）→ 隐层激活是 ReLU，且最后多一个 post_norm
    # （post_norm = LayerNorm(128)，因为 MLP.__init__ 里 self.post_norm = self.norm(output_dim)）
    return h * W[prefix + '.res_scale2.scale'] + y * W[prefix + '.layer_scale2.scale']


def node_mpnn_relu(h, he, edges, prefix):
    """NodeMPNN 的真实语义：mlp 的激活是 nn.ReLU（见文件头说明与 layers.py 的位置传参）。"""
    x = layer_norm(h, W[prefix + '.norm1.weight'], W[prefix + '.norm1.bias'])
    x = pna_conv(x, he, edges, prefix)
    h = h * W[prefix + '.res_scale1.scale'] + x * W[prefix + '.layer_scale1.scale']
    y = layer_norm(h, W[prefix + '.norm2.weight'], W[prefix + '.norm2.bias'])
    y = mlp(y, [128, 256, 128], prefix + '.mlp.', act=lambda v: np.maximum(v, 0), last_norm=True)
    return h * W[prefix + '.res_scale2.scale'] + y * W[prefix + '.layer_scale2.scale']


# ------------------------------------------------------------------ 前向
def forward(fa, grid3, ea, edges):
    N = fa.shape[0]
    ha = layer_norm(linear(fa, W['node_attr_encoder.0.weight'], W['node_attr_encoder.0.bias']),
                    W['node_attr_encoder.1.weight'], W['node_attr_encoder.1.bias'])
    hg = grid_encode(grid3, N)
    h = np.concatenate([ha, hg], axis=1)

    he = layer_norm(linear(ea, W['edge_attr_encoder.0.weight'], W['edge_attr_encoder.0.bias']),
                    W['edge_attr_encoder.1.weight'], W['edge_attr_encoder.1.bias'])

    h = node_mpnn_relu(h, he, edges, 'graph_encoder.node_convs.0')
    for _ in range(2):
        h = node_mpnn_relu(h, he, edges, 'graph_encoder.node_convs.1')

    local = layer_norm(h, W['graph_encoder.post_norm.weight'], W['graph_encoder.post_norm.bias'])
    mean = local.mean(axis=0, keepdims=True)
    g = mlp(mean, [128, 128], 'graph_encoder.linear.', act=lambda v: np.maximum(v, 0), last_norm=True)
    lg = np.concatenate([local, np.repeat(g, N, axis=0)], axis=1)

    seg = mlp(lg, [256, 64, 25], 'seg_head.')
    bottom = mlp(lg, [256, 64, 1], 'bottom_head.')
    q = mlp(lg, [256, 64, 64], 'inst_head.Wq.', last_norm=True)
    k = mlp(lg, [256, 64, 64], 'inst_head.Wk.', last_norm=True)
    inst = q @ k.T
    return seg, inst, bottom


def main():
    pre = sys.argv[1]
    load_w()
    meta = json.load(open(pre + '.meta.json'))
    N, E = meta['N'], meta['E']
    fa = np.fromfile(pre + '.fa.bin', dtype=np.float32).reshape(N, 10)
    ea = np.fromfile(pre + '.ea.bin', dtype=np.float32).reshape(E, 12)
    grid = np.fromfile(pre + '.grid.bin', dtype=np.float32).reshape(N, 7, 5, 5)

    seg, inst, bottom = forward(fa, grid, ea, meta['edges'])
    np.set_printoptions(precision=3, suppress=True, linewidth=200)

    print('== %s  N=%d E=%d' % (meta['file'], N, E))
    print('面', '  '.join('%d:%s' % (i, k) for i, k in enumerate(meta['faceKinds'])))
    segp = np.exp(seg - seg.max(axis=1, keepdims=True))
    segp /= segp.sum(axis=1, keepdims=True)
    for i in range(N):
        top = np.argsort(-seg[i])[:3]
        print('  面%-2d %-12s ' % (i, meta['faceKinds'][i]) +
              '  '.join('%d=%.3f(p%.3f)' % (c, seg[i, c], segp[i, c]) for c in top))
    sig = 1 / (1 + np.exp(-inst))
    print('inst 邻接 (>0.5):')
    for i in range(N):
        js = [j for j in range(N) if sig[i, j] > 0.5]
        print('  %-2d -> %s' % (i, js))
    print('bottom prob:', np.round(1 / (1 + np.exp(-bottom.ravel())), 3).tolist())

    if '--dump-json' in sys.argv:
        json.dump({'seg': seg.tolist(), 'inst': inst.tolist(), 'bottom': bottom.ravel().tolist()},
                  open(pre + '.ref.json', 'w'))
        print('写出', pre + '.ref.json')


if __name__ == '__main__':
    main()
