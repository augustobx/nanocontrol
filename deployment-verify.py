"""Read-only production verification for NanoControl 1.1.1."""
from pathlib import Path
import base64
import json
import urllib.request
import urllib.error

env = dict(
    line.split('=', 1)
    for line in Path('/opt/apps/nanocontrol/.env.production').read_text().splitlines()
    if '=' in line
)
authorization = 'Basic ' + base64.b64encode(
    (env['ADMIN_USER'] + ':' + env['ADMIN_PASSWORD']).encode()
).decode()

url = 'http://127.0.0.1:4173'

try:
    urllib.request.urlopen(url, timeout=5)
    raise RuntimeError('Unauthenticated request unexpectedly allowed')
except urllib.error.HTTPError as error:
    assert error.code == 401

print('Unauthenticated access: 401')

for endpoint in ['/', '/app.js', '/styles.css', '/api/healthz']:
    response = urllib.request.urlopen(
        urllib.request.Request(url + endpoint, headers={'Authorization': authorization}),
        timeout=10,
    )
    assert response.status == 200
    print(endpoint, response.status)

response = urllib.request.urlopen(
    urllib.request.Request(url + '/api/dashboard', headers={'Authorization': authorization}),
    timeout=30,
)
data = json.load(response)

print('Version:', data.get('version'))
assert data.get('version') == '1.1.1'

print('Telemetry:', json.dumps(data['server']))
for app in data['apps']:
    print(
        app['name'],
        app['health'],
        'metrics=' + str(app['usage'] is not None),
        'scheduled=' + str(app['schedule_enabled']),
        'mode=' + str(app.get('schedule_type')),
        'next=' + str(app.get('next_backup_at')),
    )

print('Backups registered:', len(data['backups']))
print('Automations enabled:', data['automation']['enabledCount'])
print('Automation timezone:', data['automation']['timeZone'])
print('Drive configured:', data['drive']['configured'])
print('Drive status:', data['drive'].get('status'))
if data['drive'].get('error'):
    print('Drive last error:', data['drive']['error'])

assert len(data['apps']) >= 9
assert data['server']['telemetryAvailable']
