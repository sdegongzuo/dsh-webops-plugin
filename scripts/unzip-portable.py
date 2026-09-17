# -*- coding: utf-8 -*-
"""把便携版 zip 解到全新目录并做 NUL 自检（Python zipfile 是本机验证过的可靠解压器）。

用法：
    python scripts/unzip-portable.py --zip dist/xxx.zip --dir D:/dsh-xxx-verify
解完统计文件数、报告前 32 字节全 0（NUL 污染）的文件数 —— 本机曾出现
解压器产出「大小正确、内容全 0」的静默损坏，这一步是分诊证据。
"""

import argparse
import os
import shutil
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', required=True)
    ap.add_argument('--dir', required=True)
    args = ap.parse_args()
    zip_path = args.zip if os.path.isabs(args.zip) else os.path.join(ROOT, args.zip)
    dest = args.dir

    t0 = time.time()
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        print(f'unzip-portable: {zip_path} -> {dest}（{len(names)} 个条目）')
        os.makedirs(dest, exist_ok=True)
        for index, name in enumerate(names):
            if index % 3000 == 0:
                print(f'  …已解 {index}/{len(names)}')
            target = os.path.join(dest, *name.split('/'))
            if name.endswith('/'):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(name) as src, open(target, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)

    # NUL 污染自检：读每个文件前 32 字节，全 0 即中招
    nul = 0
    checked = 0
    for root, _dirs, files in os.walk(dest):
        for name in files:
            path = os.path.join(root, name)
            try:
                with open(path, 'rb') as f:
                    head = f.read(32)
                checked += 1
                if head and head == b'\x00' * len(head):
                    nul += 1
            except OSError as error:
                print(f'  读不了 {path}: {error}')
    print(f'unzip-portable: 完成 {checked} 个文件，NUL 污染 {nul} 个，耗时 {time.time() - t0:.0f}s')
    return 0 if nul == 0 else 3


if __name__ == '__main__':
    sys.exit(main())
