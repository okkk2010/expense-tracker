"""Sign credential-free Moa templates for installation in Apple Shortcuts.

The HubSign request format is documented by Cherri's signing.go. Only the
template is uploaded; the collection credential is entered later on the phone.
Use --signer macos to use Apple's local shortcuts command instead.
"""

import argparse
import hashlib
import json
import pathlib
import plistlib
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
HUBSIGN = 'https://hubsign.routinehub.services/sign'
TOKEN_PATTERN = re.compile(rb'moa_sc_[A-Za-z0-9_-]{20,}')


def validate_template(data):
    if len(data) > 250_000:
        raise ValueError('Template exceeds the expected size.')
    if TOKEN_PATTERN.search(data):
        raise ValueError('Refusing to upload a template containing a collection key.')
    workflow = plistlib.loads(data)
    actions = workflow.get('WFWorkflowActions', [])
    questions = workflow.get('WFWorkflowImportQuestions', [])
    if not actions or len(questions) != 1:
        raise ValueError('Expected actions and exactly one collection-header setup question.')
    question = questions[0]
    action = actions[question['ActionIndex']]
    if question['ParameterKey'] != 'WFTextActionText':
        raise ValueError('Unexpected setup parameter.')
    if action['WFWorkflowActionIdentifier'] != 'is.workflow.actions.gettext':
        raise ValueError('The setup question must target a Text action.')
    if action['WFWorkflowActionParameters'].get('WFTextActionText') not in ('', 'Bearer ', 'PASTE_MOA_COLLECTION_HEADER'):
        raise ValueError('The template must not contain an installed collection header.')
    if question.get('DefaultValue', '') not in ('', 'Bearer ', 'PASTE_MOA_COLLECTION_HEADER'):
        raise ValueError('The setup default must not contain a credential.')
    return workflow


def hubsign(data, name):
    request = urllib.request.Request(
        HUBSIGN,
        data=json.dumps({'shortcutName': name, 'shortcut': data.decode('utf-8')}, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'User-Agent': 'cherri/2.3.0 (Moa templates)'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=55) as response:
            content_type = response.headers.get_content_type()
            if content_type not in {'application/octet-stream', 'application/x-plist', 'application/x-apple-shortcut'}:
                raise RuntimeError(f'Unexpected signing response type: {content_type}')
            signed = response.read(2_000_001)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Signing failed with HTTP {error.code}; no signed artifact was published.') from error
    if len(signed) > 2_000_000 or not signed.startswith(b'AEA1'):
        raise RuntimeError('The response is not an AEA1 signed Shortcut container.')
    return signed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--signer', choices=['hubsign', 'macos'], required=True)
    parser.add_argument('--input-dir', type=pathlib.Path, default=ROOT / 'shortcuts' / 'unsigned')
    parser.add_argument('--output-dir', type=pathlib.Path, default=ROOT / 'shortcuts' / 'signed')
    args = parser.parse_args()
    inputs = sorted(args.input_dir.glob('moa-*.plist'))
    if len(inputs) != 2:
        raise SystemExit('Expected the Toss and KB templates. Run build-iphone-shortcuts.py first.')
    templates = [(source, source.read_bytes()) for source in inputs]
    workflows = [validate_template(data) for _, data in templates]
    if args.signer == 'macos' and not shutil.which('shortcuts'):
        raise SystemExit('Apple shortcuts command is not available on this host.')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {'created_at': datetime.now(timezone.utc).isoformat(),
              'signer': HUBSIGN if args.signer == 'hubsign' else 'Apple shortcuts sign --mode anyone',
              'phone_import_verified': False, 'artifacts': []}
    for (source, data), workflow in zip(templates, workflows):
        target = args.output_dir / f'{source.stem}.shortcut'
        if args.signer == 'hubsign':
            signed = hubsign(data, workflow.get('WFWorkflowName', source.stem))
            target.write_bytes(signed)
        else:
            subprocess.run(['shortcuts', 'sign', '--mode', 'anyone', '--input', str(source), '--output', str(target)], check=True)
            signed = target.read_bytes()
            if not signed.startswith(b'AEA1'):
                raise SystemExit(f'{target.name}: Apple signer did not produce an AEA1 container.')
        artifact = {'file': target.name, 'bytes': len(signed), 'format': 'AEA1',
                    'unsigned_sha256': hashlib.sha256(data).hexdigest(),
                    'signed_sha256': hashlib.sha256(signed).hexdigest()}
        report['artifacts'].append(artifact)
        print(json.dumps(artifact))
    (args.output_dir / 'signing-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
