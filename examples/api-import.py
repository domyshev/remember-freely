#!/usr/bin/env python3
"""Upload a ZIP to an account and save the exact returned report bytes."""
import argparse
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

MAX_ZIP = 64 * 1024 * 1024
MAX_REPORT = 32 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('origin', help='Frontend origin, for example https://practice.example.com')
    parser.add_argument('zip', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    connection = None
    reserved = False
    keep_report = False
    try:
        origin = urlsplit(args.origin)
        if origin.scheme not in ('https', 'http') or not origin.hostname or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
            raise ValueError('Use a frontend origin without credentials, path, query or fragment')
        if origin.scheme == 'http' and origin.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('HTTPS is required except for local loopback development')
        secret = os.environ.get('REMEMBER_FREELY_API_KEY') or getpass.getpass('API key: ')
        if len(secret) != 46 or not secret.startswith('rf_') or not all(c.isascii() and (c.isalnum() or c in '_-') for c in secret):
            raise ValueError('Invalid API key format')
        if args.zip.is_symlink() or not args.zip.is_file() or args.zip.stat().st_size > MAX_ZIP:
            raise ValueError('Use a regular ZIP file up to 64 MiB')
        if args.zip.resolve() == args.report.resolve():
            raise ValueError('Report must not overwrite the input ZIP')
        with args.report.open('xb'):
            pass
        reserved = True
        size = args.zip.stat().st_size
        transport = http.client.HTTPSConnection if origin.scheme == 'https' else http.client.HTTPConnection
        connection = transport(origin.hostname, origin.port, timeout=480)
        connection.putrequest('POST', '/api/imports')
        connection.putheader('Authorization', 'Bearer ' + secret)
        connection.putheader('Content-Type', 'application/zip')
        connection.putheader('Content-Length', str(size))
        connection.endheaders()
        archive_digest = hashlib.sha256()
        sent = 0
        with args.zip.open('rb') as archive:
            while sent < size:
                chunk = archive.read(min(256 * 1024, size - sent))
                if not chunk:
                    raise ValueError('Input ZIP changed during upload')
                connection.send(chunk)
                archive_digest.update(chunk)
                sent += len(chunk)
                print(f'\rUploading: {sent}/{size} bytes ({sent * 100 // size}%)', end='', file=sys.stderr, flush=True)
        print('\nProcessing questions and preparing report…', file=sys.stderr)
        response = connection.getresponse()
        data = response.read(MAX_REPORT + 1)
        if len(data) > MAX_REPORT:
            raise ValueError('Response exceeds report size limit; inspect history before retrying')
        if response.status not in (200, 422) or not response.getheader('X-Report-SHA256'):
            try:
                message = json.loads(data).get('error', f'HTTP {response.status}')
            except (ValueError, AttributeError):
                message = f'HTTP {response.status}'
            raise ValueError(message)
        local_zip = archive_digest.hexdigest()
        local_report = hashlib.sha256(data).hexdigest()
        if response.getheader('X-Archive-SHA256') != local_zip or response.getheader('X-Report-SHA256') != local_report:
            raise ValueError('Checksum mismatch; inspect history before retrying')
        report = json.loads(data)
        if report.get('outcome') != ('accepted' if response.status == 200 else 'rejected'):
            raise ValueError('Unexpected report outcome')
        args.report.write_bytes(data)
        keep_report = True
        print('Report ready and checksums verified.', file=sys.stderr)
        print(json.dumps({'accepted': response.status == 200, 'upload_id': response.getheader('X-Import-ID'),
                          'archive_sha256': local_zip, 'report_sha256': local_report,
                          'report_created_at': response.getheader('X-Report-Created-At'), 'report_path': str(args.report)}, indent=2))
        return 0 if response.status == 200 else 1
    except (OSError, ValueError, http.client.HTTPException) as error:
        print(f'Import error: {error}', file=sys.stderr)
        return 1
    finally:
        if connection:
            connection.close()
        if reserved and not keep_report:
            args.report.unlink(missing_ok=True)


if __name__ == '__main__':
    sys.exit(main())
