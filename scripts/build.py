"""Validate and package the plugin from any working directory."""
from pathlib import Path
import hashlib
import json
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = ROOT / 'outputs'
FILES = ['manifest.json', 'bootstrap.js', 'core.js', 'providers.js', 'runtime.js',
         'settings.js', 'settings.xhtml', 'settings.css', 'qrcode.js', 'QR_LICENSE.txt', 'LICENSE', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY.md']


def main():
    OUTPUTS.mkdir(exist_ok=True)
    window = ET.parse(ROOT / 'settings.xhtml').getroot()
    if window.tag != '{http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul}window':
        raise ValueError('Settings must use a native XUL window root')
    scripts = list(window.iter('{http://www.w3.org/1999/xhtml}script'))
    if not any(s.get('src') == 'chrome://cloud-on-demand/content/settings.js' for s in scripts):
        raise ValueError('Settings script must use the registered privileged chrome URL')
    if [s.get('src') for s in scripts] != [
            'chrome://cloud-on-demand/content/qrcode.js',
            'chrome://cloud-on-demand/content/settings.js']:
        raise ValueError('QR renderer must load locally before settings; no remote scripts')
    styles = [link.get('href') for link in window.iter('{http://www.w3.org/1999/xhtml}link')
              if link.get('rel') == 'stylesheet']
    if styles != ['chrome://cloud-on-demand/content/settings.css']:
        raise ValueError('Settings stylesheet must use the registered local chrome URL')
    buttons = {b.get('id'): b for b in window.iter('{http://www.w3.org/1999/xhtml}button')}
    for name in ['save-top', 'save']:
        if name not in buttons or buttons[name].get('type') != 'button' or buttons[name].text != '保存配置':
            raise ValueError('Settings must expose both explicit save controls')
    manifest = json.loads((ROOT / 'manifest.json').read_text('utf-8'))
    app = manifest['applications']['zotero']
    for field in ['id', 'update_url', 'strict_max_version']:
        if not isinstance(app.get(field), str) or not app[field]:
            raise ValueError('Zotero requires applications.zotero.' + field)
    if app['strict_min_version'] != '10.0' or app['strict_max_version'] != '10.*':
        raise ValueError('Compatibility changes require a separate runtime audit')
    if not app['update_url'].startswith('https://127.0.0.1:9/'):
        raise ValueError('The prototype update endpoint must remain local')
    version = manifest['version']
    archive = OUTPUTS / ('cloud-on-demand-' + version + '.xpi')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for name in FILES:
            package.write(ROOT / name, name)
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None or set(package.namelist()) != set(FILES):
            raise ValueError('Archive integrity or file-list validation failed')
        for name in FILES:
            if package.read(name) != (ROOT / name).read_bytes():
                raise ValueError('Archive content mismatch: ' + name)
    sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    report = {
        'artifact': archive.name, 'bytes': archive.stat().st_size, 'sha256': sha,
        'package_checks': 'manifest required fields, XHTML parsing, ZIP CRC, exact entry bytes',
        'automated_tests': {
            'last_recorded_passed': 121,
            'scope': 'mock protocol, runtime and settings UI tests; no real account',
            'note': 'Build validates packaging; run npm test separately.',
        },
        'zotero_settings_smoke_test': '0.2.2: passed in isolated offline Zotero 10.0.8 with mock runtime; path field, provider switching and wide/narrow layouts',
        'zotero_application_smoke_test': 'production add-on startup and end-to-end sync not verified; the settings smoke test uses a dedicated test add-on',
        'installed_webdav_source_check': 'Zotero 10.0.8 checkServer source passed OPTIONS/PROPFIND/GET/PUT/GET/DELETE with mocked HTTP and in-memory provider; not a native-network test',
        'installed_httpd_identity_check': 'Installed ServerIdentity and _validateRequest source reproduced numeric-loopback Host rejection: HTTP 400 before setPrimary, accepted after; mocked metadata, no native socket test',
        'baidu_device_code_flow': 'Official Baidu documentation; protocol and token persistence covered by mocks; no account authorized',
        'native_gecko_bridge_harness': 'not verified: isolated application did not reach harness entry; only test-created process stopped',
        'real_cloud_account_test': 'not performed',
        'anonymous_quark_qr_probe': '2026-11-19: token status 2000000; unscanned polling status 50004001; no account authenticated',
        'target_client': 'Zotero 10; source inspected from installed 10.0.8',
    }
    (OUTPUTS / 'VALIDATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (OUTPUTS / ('cloud-on-demand-' + version + '.sha256')).write_text(sha + '  ' + archive.name + '\n', encoding='ascii')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
