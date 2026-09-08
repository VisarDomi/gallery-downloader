"""Daily Xcode renewal in a logged-in Mac user session.

Self-contained stdlib runner, also carried by gallery-downloader/apps/ios/scripts.
No source fetch, JavaScript rebuild, certificate revocation or app uninstall.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.state-')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def fingerprint(root, inputs):
    digest = hashlib.sha256()
    for item in sorted(inputs):
        base = root / item
        if not base.exists():
            raise RuntimeError('Missing approved input: ' + item)
        files = sorted(base.rglob('*')) if base.is_dir() else [base]
        for path in files:
            if not path.is_file() or 'xcuserdata' in path.parts or path.name == '.DS_Store':
                continue
            digest.update(str(path.relative_to(root)).encode() + b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def profile(path):
    raw = subprocess.check_output(['/usr/bin/security', 'cms', '-D', '-i', str(path)], stderr=subprocess.PIPE)
    data = plistlib.loads(raw)
    return {
        'id': data['Entitlements']['application-identifier'],
        'uuid': data['UUID'],
        'expires': data['ExpirationDate'].replace(tzinfo=dt.timezone.utc).timestamp(),
    }


def app_profiles(app, expected):
    paths = [app / 'embedded.mobileprovision', *sorted(app.glob('PlugIns/*.appex/embedded.mobileprovision'))]
    profiles = [profile(path) for path in paths]
    result = {item['id']: item for item in profiles}
    if set(result) != set(expected) or len(result) != len(profiles):
        raise RuntimeError('App/profile identities differ from the approved configuration')
    return result


def advanced(before, after, now):
    return bool(before) and set(before) == set(after) and all(
        after[key]['expires'] > before[key]['expires'] and after[key]['expires'] > now + 6 * 86400
        for key in before
    )


def device_json(config, arguments):
    timeout = 180 if arguments[0] == 'install' else 45
    with tempfile.TemporaryDirectory(prefix='reader-device-') as directory:
        output = Path(directory) / 'result.json'
        subprocess.run(['/usr/bin/xcrun', 'devicectl', '--timeout', str(timeout), '--json-output', str(output),
                        'device', *arguments, '--device', config['device']],
                       check=True, timeout=timeout + 15, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return json.loads(output.read_text())['result']


def restore_cache(stash, cache):
    # A power cut leaves the stash intact. The next run restores it first.
    if not stash.exists():
        return
    for backup in stash.glob('*.mobileprovision'):
        destination = cache / backup.name
        if destination.exists():
            if destination.read_bytes() != backup.read_bytes():
                raise RuntimeError('Profile cache changed; keep backup for manual inspection')
            backup.unlink()
        else:
            os.replace(backup, destination)


def run(config, action, force=False, wireless=False):
    root = Path(config['root']).resolve()
    state_dir = root / 'build/refresh'
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_path = state_dir / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    app = root / config['app']
    expected = [config['team'] + '.' + identity for identity in config['bundleIds']]
    if action == 'status':
        print(json.dumps(state, indent=2))
        return
    current_hash = fingerprint(root, config['inputs'])
    if action == 'approve':
        subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        state = {'inputHash': current_hash, 'installedProfiles': app_profiles(app, expected), 'lastSuccess': 0}
        save(state_path, state)
        print('Approved current delivered inputs and app IDs. No renewal claimed.')
        return
    if state.get('inputHash') != current_hash:
        raise RuntimeError('Inputs changed or not approved. Install/review deliberately, then run approve.')
    if not force and time.time() - state.get('lastSuccess', 0) < 86400:
        print('Daily renewal already completed; no build or install needed.')
        return
    lock_dir = Path.home() / 'Library/Caches/ios-app-refresh'
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (lock_dir / 'signing.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another app is signing; retry on the next check.')
            return
        cache = Path(config['profileCache'])
        stash = state_dir / 'profile-cache-backup'
        stash.mkdir(exist_ok=True)
        restore_cache(stash, cache)
        if subprocess.run(['/usr/bin/pgrep', '-x', 'xcodebuild'], stdout=subprocess.DEVNULL).returncode == 0:
            print('An Xcode build is already running; retry on the next check.')
            return
        info = device_json(config, ['info', 'details'])
        transport = info['connectionProperties']['transportType']
        if wireless and transport != 'localNetwork':
            raise RuntimeError('Wireless test requires USB disconnected; transport=' + transport)
        print('Connection: ' + transport, flush=True)
        lock_state = device_json(config, ['info', 'lockState'])
        if lock_state.get('passcodeRequired') is not False or lock_state.get('unlockedSinceBoot') is not True:
            print('Phone locked; no build. Daily renewal remains due for the next check.', flush=True)
            return
        before = state['installedProfiles']
        try:
            # Only these exact app IDs, never certificates or unrelated profiles.
            for cached in cache.glob('*.mobileprovision'):
                if profile(cached)['id'] in expected:
                    os.replace(cached, stash / cached.name)
            environment = {**os.environ, **config.get('environment', {})}
            with (state_dir / 'build.log').open('w') as log:
                result = subprocess.run(config['build'], cwd=root, env=environment,
                                        stdout=log, stderr=subprocess.STDOUT, timeout=900)
            if result.returncode:
                raise RuntimeError('Xcode build failed; see build/refresh/build.log')
            if fingerprint(root, config['inputs']) != current_hash:
                raise RuntimeError('Build inputs changed during renewal; refusing installation')
            after = app_profiles(app, expected)
            if not advanced(before, after, time.time()):
                raise RuntimeError('Profiles did not ALL receive later seven-day deadlines; no renewal claimed')
            subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
            device_json(config, ['install', 'app', str(app)])
            state.update(lastSuccess=time.time(), installedProfiles=after, transport=transport, lastError=None)
            save(state_path, state)
            # Successful replacement: retain no unbounded archive of old profiles.
            for backup in stash.glob('*.mobileprovision'):
                backup.unlink()
            for identity in sorted(after):
                print(identity + ': ' + dt.datetime.fromtimestamp(before[identity]['expires'], dt.timezone.utc).isoformat()
                      + ' -> ' + dt.datetime.fromtimestamp(after[identity]['expires'], dt.timezone.utc).isoformat())
            print('Daily renewal installed successfully; app data preserved.', flush=True)
        except BaseException:
            restore_cache(stash, cache)
            raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['approve', 'refresh', 'status'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--wireless', action='store_true')
    parser.add_argument('--scheduled', action='store_true', help='Keep only the latest check log')
    args = parser.parse_args()
    settings = json.loads(Path(args.config).read_text())
    if args.scheduled:
        log_dir = Path(settings['root']) / 'build/refresh'
        log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Bound diagnostics: one check log and one overwritten Xcode build log.
        log_fd = os.open(log_dir / 'last-check.log', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)
        os.close(log_fd)
        print(dt.datetime.now(dt.timezone.utc).isoformat(), flush=True)
    try:
        run(settings, args.action, args.force, args.wireless)
    except Exception as error:
        state_path = Path(settings['root']) / 'build/refresh/state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        state.update(lastError=str(error), lastAttempt=time.time())
        save(state_path, state)
        print('REFRESH FAILED: ' + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
