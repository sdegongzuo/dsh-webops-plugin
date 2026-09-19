# -*- coding: utf-8 -*-
"""把便携版 zip 解到全新目录并做 NUL 自检（Python zipfile 是本机验证过的可靠解压器）。

用法：
    python scripts/unzip-portable.py --zip dist/xxx.zip --dir D:/dsh-xxx-verify
    # 换桌面壳时只解 app/，保住 home/（固定测试目录见 .env.local 的 DSH_PORTABLE_TEST_DIR）
    python scripts/unzip-portable.py --zip dist/xxx.zip --dir <便携版目录> --only-prefix app/
解完统计文件数、报告前 32 字节全 0（NUL 污染）的文件数 —— 本机曾出现
解压器产出「大小正确、内容全 0」的静默损坏，这一步是分诊证据。

`--only-prefix` 只解该前缀下的条目（如换桌面壳时只解 `app/`，保住 `home/` 里的会话与插件）。
给了它，NUL 自检就**只扫本次真正写出的文件** —— 没解的东西扫了也证明不了本次解压的好坏。
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
    ap.add_argument('--only-prefix', default=None,
                    help='只解压该前缀下的条目，例如 app/')
    args = ap.parse_args()
    zip_path = args.zip if os.path.isabs(args.zip) else os.path.join(ROOT, args.zip)
    dest = args.dir

    t0 = time.time()
    written = []
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        selected = [n for n in names if args.only_prefix is None or n.startswith(args.only_prefix)]
        scope = '全部' if args.only_prefix is None else f'前缀 {args.only_prefix}'
        print(f'unzip-portable: {zip_path} -> {dest}（{scope}：{len(selected)}/{len(names)} 个条目）')
        if not selected:
            print(f'unzip-portable: 前缀 {args.only_prefix} 下一个条目都没有 —— 检查 --only-prefix 拼写')
            return 2
        os.makedirs(dest, exist_ok=True)
        for index, name in enumerate(selected):
            if index % 3000 == 0:
                print(f'  …已解 {index}/{len(selected)}')
            target = os.path.join(dest, *name.split('/'))
            if name.endswith('/'):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(name) as src, open(target, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            written.append(target)

    # NUL 污染自检：读每个文件前 32 字节，全 0 即中招
    nul = 0
    checked = 0
    # 指定了前缀就只扫本次写出的那些（没解的东西扫了跟本次解压无关）；
    # 否则沿用旧行为，把整个 dest 走一遍。
    if args.only_prefix is None:
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
    else:
        for path in written:
            try:
                with open(path, 'rb') as f:
                    head = f.read(32)
                checked += 1
                if head and head == b'\x00' * len(head):
                    nul += 1
            except OSError as error:
                print(f'  读不了 {path}: {error}')
    print(f'unzip-portable: 完成 写出 {len(written)} / 自检 {checked} 个文件，NUL 污染 {nul} 个，耗时 {time.time() - t0:.0f}s')
    return 0 if nul == 0 else 3


if __name__ == '__main__':
    sys.exit(main())
