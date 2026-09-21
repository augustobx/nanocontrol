"""Read-only checks; authorization stays inside this process."""
from pathlib import Path
import base64
import json
import urllib.request
import urllib.error

env = dict(line.split('=', 1) for line in Path('/opt/apps/nanocontrol/.env.production').read_text().splitlines() if '=' in line)
authorization = 'Basic ' + base64.b64encode((env['ADMIN_USER'] + ':' + env['ADMIN_PASSWORD']).encode()).decode()
url = 'http://127.0.0.1:4173'
try:
    urllib.request.urlopen(url, timeout=5)
    raise RuntimeError('Unauthenticated request unexpectedly allowed')
except urllib.error.HTTPError as error:
    assert error.code == 401
print('Unauthenticated access: 401')
for endpoint in ['/', '/app.js', '/styles.css', '/api/healthz']:
    response = urllib.request.urlopen(urllib.request.Request(url+endpoint, headers={'Authorization':authorization}), timeout=10)
    assert response.status == 200
    print(endpoint, response.status)
response = urllib.request.urlopen(urllib.request.Request(url+'/api/dashboard', headers={'Authorization':authorization}), timeout=25)
data = json.load(response)
print('Telemetry:', json.dumps(data['server']))
for app in data['apps']:
    print(app['name'], app['health'], 'metrics='+str(app['usage'] is not None), 'scheduled='+str(app['schedule_enabled']))
print('Backups registered:', len(data['backups']))
print('Drive configured:', data['drive']['configured'])
assert len(data['apps']) == 9
assert data['server']['telemetryAvailable']
assert all(not app['schedule_enabled'] for app in data['apps'])
