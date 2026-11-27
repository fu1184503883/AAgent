# -*- coding: utf-8 -*-
"""把 AAGNet 的 weight_on_MFInstseg.pth 转成浏览器可直接加载的 aagnet_weights.js。

不依赖 torch：torch.save 产物是 zip（data.pkl + data/<key> 裸字节），
这里用自定义 Unpickler 把 rebuild_tensor_v2 还原成 numpy 数组。

    python tools/pth2js.py <weight.pth> [out.js]
"""
import base64
import io
import json
import pickle
import sys
import zipfile

import numpy as np

DTYPES = {
    'FloatStorage': np.float32, 'DoubleStorage': np.float64, 'HalfStorage': np.float16,
    'LongStorage': np.int64, 'IntStorage': np.int32, 'ShortStorage': np.int16,
    'CharStorage': np.int8, 'ByteStorage': np.uint8, 'BoolStorage': np.bool_,
}


class StorageType(object):
    def __init__(self, name):
        self.name = name


class Loader(object):
    def __init__(self, zipf, raw_pkl):
        self.zipf = zipf
        self.raw = raw_pkl
        self.storages = {}

    def load(self):
        owner = self

        class _U(pickle.Unpickler):
            def find_class(self, module, name):
                if module == 'torch._utils' and name in ('_rebuild_tensor_v2', '_rebuild_tensor'):
                    return owner.rebuild
                if module == 'torch' and name.endswith('Storage'):
                    return StorageType(name)
                if module == 'collections' and name == 'OrderedDict':
                    import collections
                    return collections.OrderedDict
                if module.startswith('torch'):
                    return lambda *a, **k: None
                return pickle.Unpickler.find_class(self, module, name)

            def persistent_load(self, pid):
                if pid[0] == 'storage':
                    return ('storage', pid[1].name, pid[2], int(pid[4]))
                return None

        return _U(io.BytesIO(self.raw)).load()

    def storage_array(self, stype, key, numel):
        ck = (stype, key)
        if ck not in self.storages:
            names = self.zipf.namelist()
            cand = [n for n in names if n.endswith('/' + key)] or [n for n in names if n == key]
            raw = self.zipf.read(cand[0])
            self.storages[ck] = np.frombuffer(raw, dtype=DTYPES[stype], count=numel).copy()
        return self.storages[ck]

    def rebuild(self, storage, offset, size, stride, *args):
        base = self.storage_array(storage[1], storage[2], storage[3])
        size = tuple(int(s) for s in size)
        stride = tuple(int(s) for s in stride)
        if not size:
            return np.array(base[offset])
        grids = np.indices(size, dtype=np.int64)
        off = np.zeros(size, dtype=np.int64)
        for d in range(len(size)):
            off += grids[d] * stride[d]
        return base[off + offset].copy()


def load_state_dict(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        pkl = 'archive/data.pkl' if 'archive/data.pkl' in names else [n for n in names if n.endswith('data.pkl')][0]
        return Loader(z, z.read(pkl)).load()


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'aagnet_weights.js'
    sd = load_state_dict(src)

    index, chunks, pos = {}, [], 0
    for k, v in sd.items():
        if not isinstance(v, np.ndarray):
            continue
        arr = v.astype(np.float32).ravel(order='C')
        index[k] = [pos] + list(arr.shape)
        chunks.append(arr)
        pos += arr.size
    flat = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)

    b64 = base64.b64encode(flat.tobytes()).decode('ascii')
    with io.open(out, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('/* AAGNet 权重（tools/pth2js.py 从 weight_on_MFInstseg.pth 转换，勿手改）\n')
        fh.write(' * %.4f M 参数 / %d 个 float / base64 %d KB\n */\n' % (flat.size / 1e6, flat.size, len(b64) // 1024))
        fh.write('window.AAG_W = {\n"n":%d,\n"idx":%s,\n"b64":"%s"\n};\n'
                 % (flat.size, json.dumps(index, ensure_ascii=False, separators=(',', ':')), b64))

    print('张量 %d，浮点 %d（%.4f M），写出 %s' % (len(index), flat.size, flat.size / 1e6, out))


if __name__ == '__main__':
    main()
