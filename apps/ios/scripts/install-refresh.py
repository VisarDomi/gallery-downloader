"""Install the user LaunchAgent after a verified wireless renewal."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

from refresh import fingerprint
import json

parser = argparse.ArgumentParser()
parser.add_argument('--config', required=True)
parser.add_argument('--template', required=True)
args = parser.parse_args()
config_path = Path(args.config).resolve()
config = json.loads(config_path.read_text())
root = Path(config['root']).resolve()
state = json.loads((root / 'build/refresh/state.json').read_text())
if (not state.get('lastSuccess') or state.get('transport') != 'localNetwork'
        or state.get('inputHash') != fingerprint(root, config['inputs'])):
    raise SystemExit('Complete a successful approved wireless refresh before enabling automation.')
template = plistlib.loads(Path(args.template).read_bytes())
def expand(value):
    if isinstance(value, str):
        return value.replace('@ROOT@', str(root)).replace('@CONFIG@', str(config_path))
    if isinstance(value, list):
        return [expand(item) for item in value]
    if isinstance(value, dict):
        return {key: expand(item) for key, item in value.items()}
    return value
job = expand(template)
domain = 'gui/' + str(os.getuid())
label = job['Label']
if subprocess.run(['/bin/launchctl', 'print', domain + '/' + label],
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
    raise SystemExit('Job is already loaded. Wait for any active refresh, then bootout before replacing it.')
directory = Path.home() / 'Library/LaunchAgents'
directory.mkdir(parents=True, exist_ok=True)
destination = directory / (label + '.plist')
fd, temporary = tempfile.mkstemp(dir=directory, prefix='.refresh-')
try:
    with os.fdopen(fd, 'wb') as output:
        plistlib.dump(job, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, destination)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(destination)], check=True)
print('Enabled ' + label + ': check every 10 minutes; renew once per successful 24 hours.')
