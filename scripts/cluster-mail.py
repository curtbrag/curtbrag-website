"""Per-device mailbox health and self-tests. No arbitrary recipients or mail reading."""
import base64
import imaplib
import json
import os
from pathlib import Path
import smtplib
import ssl
import sys
import time
from datetime import datetime, timezone
from email.message import EmailMessage


def run(config, spec):
    action = spec.get('action')
    if action not in ('check', 'test'):
        raise ValueError('Only connection checks and tests to this mailbox are supported')
    address = config['address']
    ident = str(spec.get('id', ''))
    if (action == 'test' or spec.get('verify_test') is True) and (not ident or len(ident) > 80 or not all(c.isalnum() or c == '-' for c in ident)):
        raise ValueError('Invalid self-test ID')
    result = {'address': address, 'action': action, 'checked_at': datetime.now(timezone.utc).isoformat()}
    context = ssl.create_default_context()
    with imaplib.IMAP4_SSL('imap.foundermail.mx', 993, ssl_context=context, timeout=15) as client:
        client.login(address, config['imap_password'])
        result['imap_verified'] = client.noop()[0] == 'OK'
        if spec.get('verify_test') is True:
            client.select('INBOX', readonly=True)
            status, matches = client.search(None, 'HEADER', 'Message-ID', '"<fleet-' + ident + '@curtbrag.com>"')
            result['delivery_verified'] = status == 'OK' and bool(matches[0].strip())
    try:
        with smtplib.SMTP('mail.smtp2go.com', 587, timeout=15) as client:
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
            client.login(config['smtp_username'], config['smtp_password'])
            result['smtp_verified'] = True
            if action == 'test':
                message = EmailMessage()
                message['From'] = address
                message['To'] = address
                message['Subject'] = 'Fleet mail test ' + ident
                message['Message-ID'] = '<fleet-' + ident + '@curtbrag.com>'
                message.set_content('Email connection test from this fleet device to its own mailbox.')
                result['accepted'] = not client.send_message(message)
                result['delivery_verified'] = False
    except Exception as error:
        # A failed QUIT cannot revoke the server's successful send response.
        if result.get('accepted') is not True:
            raise
        result['delivery_error'] = type(error).__name__
    if action == 'test' and result.get('accepted'):
        try:
            with imaplib.IMAP4_SSL('imap.foundermail.mx', 993, ssl_context=context, timeout=15) as client:
                client.login(address, config['imap_password'])
                client.select('INBOX', readonly=True)
                for attempt in range(4):
                    status, matches = client.search(None, 'HEADER', 'Message-ID', '"<fleet-' + ident + '@curtbrag.com>"')
                    if status == 'OK' and matches[0].strip():
                        result['delivery_verified'] = True
                        break
                    if attempt < 3:
                        time.sleep(2)
        except Exception as error:
            result['delivery_error'] = type(error).__name__
        result['delivery_unconfirmed'] = not result['delivery_verified']
    return result


def main():
    path = Path(__file__).with_name('mailbox.json')
    if os.name != 'nt' and path.stat().st_mode & 0o077:
        raise ValueError('Mailbox configuration must be private')
    config = json.loads(path.read_text(encoding='utf-8'))
    spec = json.loads(base64.b64decode(sys.argv[1], validate=True)) if len(sys.argv) > 1 else {'action':'check'}
    try:
        print(json.dumps({'ok':True, **run(config, spec)}))
    except Exception as exc:
        print(json.dumps({'ok':False, 'address':config['address'], 'error':type(exc).__name__}))
        sys.exit(1)


if __name__ == '__main__':
    main()
