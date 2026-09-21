"""Initialize only NanoControl's own deployment; never print credentials."""
from pathlib import Path
import os
import secrets

root = Path('/opt/apps/nanocontrol')
assert root.is_dir() and not root.is_symlink()
os.chown('/opt/backups/nanocontrol', 0, 0)
os.chmod('/opt/backups/nanocontrol', 0o700)
for item in ['data', 'secrets']:
    (root / item).mkdir(mode=0o700, exist_ok=True)
config = root / '.env.production'
with config.open('x') as stream:
    os.chmod(config, 0o600)
    stream.write('ADMIN_USER=augusto\nADMIN_PASSWORD=' + secrets.token_urlsafe(32) + '\nRCLONE_REMOTE=nanolabs-drive\nRCLONE_PATH=Nanolabs/Backups/Produccion\n')
print('NanoControl initialized; credentials stored only in its protected .env.production')
