# -*- coding: utf-8 -*-
"""把打包脚本的暂存目录压成 zip（Compress-Archive 被锁时的备用通道）。

为什么存在：火绒 HipsDaemon 会对新建的大文件（app.asar）挂扫描句柄，Compress-Archive
以独占方式打开文件，直接 PermissionDenied；Python 的 open() 走共享读，能正常压。
用法：
    python scripts/zip-stage.py --stage .desktop-stage-026 --out dist/.building-xxx.zip
保留式打包加 --no-overwrite：独占创建新 ZIP，不删除或覆盖已有输出。
参数缺省时压 `.desktop-stage`。压完自动 testzip + 打印 sha256。
"""

import argparse
import hashlib
import os
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    # Windows CI 的管道默认可能是 cp1252；中文路径、日志及错误统一按 UTF-8 输出。
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='.desktop-stage')
    ap.add_argument('--out', required=True)
    ap.add_argument('--level', type=int, default=1, help='deflate 级别，1=Fastest（与脚本一致）')
    ap.add_argument('--no-overwrite', action='store_true', help='仅创建新 ZIP；已有输出及竞争创建均拒绝，不执行删除')
    args = ap.parse_args()

    stage = args.stage if os.path.isabs(args.stage) else os.path.join(ROOT, args.stage)
    out = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
    if not os.path.isdir(stage):
        print(f'zip-stage: 暂存目录不存在：{stage}', file=sys.stderr)
        return 1
    if args.no_overwrite and os.path.exists(out):
        print(f'zip-stage: 目标已存在，保留模式拒绝覆盖：{out}', file=sys.stderr)
        return 1

    t0 = time.time()
    files, dirs = [], []
    for root, dnames, fnames in os.walk(stage):
        rel = os.path.relpath(root, stage)
        dnames.sort()
        for name in sorted(fnames):
            full = os.path.join(root, name)
            arc = name if rel == '.' else os.path.join(rel, name).replace(os.sep, '/')
            files.append((full, arc))
        for name in dnames:
            arc = name if rel == '.' else os.path.join(rel, name).replace(os.sep, '/')
            dirs.append(arc)
    print(f'zip-stage: {stage} -> {out}（文件 {len(files)}，目录 {len(dirs)}）')

    if not args.no_overwrite and os.path.exists(out):
        os.remove(out)
    try:
        archive = zipfile.ZipFile(out, 'x' if args.no_overwrite else 'w', zipfile.ZIP_DEFLATED, compresslevel=args.level)
    except FileExistsError:
        print(f'zip-stage: 压缩前目标出现，保留模式拒绝覆盖：{out}', file=sys.stderr)
        return 1
    with archive as z:
        for arc in dirs:
            zi = zipfile.ZipInfo(arc + '/', date_time=(2026, 9, 17, 18, 13, 0))
            zi.external_attr = 0x10  # 目录位
            z.writestr(zi, b'')
        done = 0
        for full, arc in files:
            z.write(full, arc)
            done += 1
            if done % 3000 == 0:
                print(f'  …已写入 {done}/{len(files)}')

    size = os.path.getsize(out)
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        names = z.namelist()
    h = hashlib.sha256()
    with open(out, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    print(f'zip-stage: 完成 {size / 1024 / 1024:.1f} MB，{len(names)} 个条目，testzip = {bad}')
    print(f'sha256: {h.hexdigest()}')
    print(f'耗时 {time.time() - t0:.0f}s')
    return 0 if bad is None else 2


if __name__ == '__main__':
    sys.exit(main())
