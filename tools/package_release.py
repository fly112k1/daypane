#!/usr/bin/env python3
"""Build reproducible plugin ZIP and checksums; never bundle local settings."""
import hashlib
import json
import re
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]

# 版本号以前在 package.json / main.lua / 本文件里各写一份，漏改一处就会
# 发出"包叫 0.3.3、插件自报 0.3.2"的产物。以 package.json 为唯一来源。
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
plugin_version = re.search(r'local VERSION = "([^"]+)"',
                           (ROOT / 'KindleDash.koplugin' / 'main.lua').read_text(encoding='utf-8'))
if not plugin_version or plugin_version.group(1) != VERSION:
    raise ValueError('version drift: package.json=%s, main.lua=%s'
                     % (VERSION, plugin_version.group(1) if plugin_version else 'missing'))


def package(output=Path('dist')):
    output.mkdir(parents=True, exist_ok=True)
    files = sorted((ROOT / 'KindleDash.koplugin').glob('*.lua'))
    files += [ROOT / p for p in ('README.md', 'README.zh-CN.md', 'docs/UPGRADE.md',
                                 'docs/UPGRADE.zh-CN.md', 'CHANGELOG.md')]
    target = output / f'ShawnKanban-{VERSION}.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            # 归档内路径必须相对仓库根，否则会把本机绝对路径写进 zip。
            arcname = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(arcname, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    (output / 'SHA256SUMS').write_text(
        hashlib.sha256(target.read_bytes()).hexdigest() + '  ' + target.name + '\n')
    return target


if __name__ == '__main__':
    print(package())
