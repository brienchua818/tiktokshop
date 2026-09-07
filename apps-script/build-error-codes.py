#!/usr/bin/env python3
"""
Generate ERROR-CODES.md from the sources.

Every `fail_('TS-XXX-NN', ...)` and every `code: 'TS-XXX-NN'` in the .gs files
is a row. The document is derived, never edited by hand, so it cannot say
something the code does not. The test suite checks that the generated file is
current and that no code is used twice.

    python3 apps-script/build-error-codes.py
"""
import pathlib
import re

HERE = pathlib.Path(__file__).parent
OUT = HERE / 'ERROR-CODES.md'
SKIP = {'TikShopBackend.gs'}

AREAS = {
    'API': 'Routing, roles and request handling (Api.gs)',
    'AUTH': 'Google sign-in and the user allowlist (Auth.gs)',
    'CFG': 'Configuration and Script Properties (Config.gs)',
    'EXP': 'Exports to Drive, photos in the purchase order (Export.gs)',
    'LCK': 'The script lock that serialises writes (Lock.gs)',
    'ORD': 'Order sync and summaries (Orders.gs)',
    'PRD': 'Products, variations, pushes (Product.gs)',
    'SHT': 'The data spreadsheet (Sheet.gs)',
    'TT': 'TikTok API transport, tokens, authorisation (TikTok.gs)',
    'UNC': 'Not raised by this code: the runtime threw something nobody anticipated',
}

# Fixed entries that are not literal fail_ sites.
FIXED = [
    ('TS-UNC-00', 'Api.gs', 'An error without a code reached the API handler. The message is prefixed '
                            'with the runtime error type (TypeError, Exception). This is a gap in the code: '
                            'find the line from the execution log stack and give it a code.'),
    ('LISTING_FULL', 'Product.gs', 'The listing holds 100 variations, TikTok\'s cap for Singapore. Not a fault: '
                                   'the app offers a continuation listing.'),
    ('LISTING_BUSY', 'Lock.gs', 'Another write holds the script lock. Not a fault: the client retries. '
                                'If it persists for minutes, a write is stuck — read the execution log.'),

    # The sign-in layer refuses through refuse_(), not fail_(), so none of
    # these is a TS- code and the scanner below cannot see them. They were
    # therefore absent from this registry, which is the one place the app tells
    # people to look — and they are the codes most likely to be photographed,
    # because every one of them stops the whole app rather than one action.
    ('NO_TOKEN', 'Auth.gs', 'The request reached the backend carrying no sign-in at all. Almost never means '
                            'signed out: the client refuses to send a request without one. It means the POST '
                            'body was dropped by the redirect Apps Script answers with. The app retries as a '
                            'GET and reports CREDENTIAL_LOST_IN_TRANSIT if that also fails.'),
    ('CREDENTIAL_LOST_IN_TRANSIT', 'script-api.ts', 'Both attempts reached the backend without the sign-in. '
                                                    'The session is still good; the request is not. Try again.'),
    ('SESSION_EXPIRED', 'Auth.gs', 'The 14-hour backend session has run out. Signing in again is the fix, and '
                                   'this is the only common code for which that is true.'),
    ('SESSION_INVALID', 'Auth.gs', 'The session token did not verify. Either it was edited, or SESSION_SECRET '
                                   'changed in Script Properties, which invalidates every session at once.'),
    ('TOKEN_REJECTED', 'Auth.gs', 'Google refused the ID token, normally because it is over an hour old. '
                                  'Sign in again.'),
    ('GOOGLE_TOKEN_STALE', 'api.ts', 'The Google ID token is stale and silent renewal declined. Only AI name '
                                     'and Voice need it; everything else keeps working. Sign out and back in.'),
    ('GOOGLE_UNREACHABLE', 'Auth.gs', 'The backend could not reach Google to check the sign-in. Nobody is '
                                      'signed out; wait and retry.'),
    ('BACKEND_NOT_CONFIGURED', 'Auth.gs', 'The backend has no Google client id, so it cannot verify anyone. '
                                          'A deployment fault. Run checkSetup.'),
    ('CLIENT_ID_MISMATCH', 'Auth.gs', 'The app and the backend are configured for different Google clients. '
                                      'Run checkSetup for both values.'),
    ('ACCOUNT_BLOCKED', 'Api.gs', 'This account is blocked in the Users tab. An admin can change it under '
                                  'More then Users.'),
    ('AWAITING_APPROVAL', 'Api.gs', 'The account signed in but has never been approved. An admin approves it '
                                    'under More then Users.'),
    ('TIMEOUT', 'script-api.ts', 'The phone gave up waiting. On a read nothing changed and retrying is safe; '
                                 'on a write the outcome is unknown and the queue asks before assuming.'),
]

pat = re.compile(r"(?:fail_|warn_)\(\s*'(TS-[A-Z]+-\d+)'\s*,\s*(.*)", re.S)
code_lit = re.compile(r"code\s*[:=]\s*'(TS-[A-Z]+-\d+)'")


def message_of(rest: str) -> str:
    """Best-effort: the first string literal(s) of the message expression, joined."""
    # Take everything up to the closing paren of this fail_ call, roughly one statement.
    stmt = rest.split(');', 1)[0]
    parts = re.findall(r"'((?:[^'\\]|\\.)*)'", stmt)
    text = ' '.join(p.strip() for p in parts if p.strip())
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:220] + ('…' if len(text) > 220 else '')


def scan():
    rows = []
    for f in sorted(HERE.glob('*.gs')):
        if f.name in SKIP:
            continue
        src = f.read_text()
        for i, line in enumerate(src.splitlines(), 1):
            for m in pat.finditer(line):
                rest = '\n'.join(src.splitlines()[i - 1:i + 4])
                rest = rest[rest.index(m.group(1)) + len(m.group(1)) + 2:]
                rows.append((m.group(1), f.name, i, message_of(rest)))
            for m in code_lit.finditer(line):
                rows.append((m.group(1), f.name, i, 'Non-fatal reason attached to a result (see the line).'))
    return rows


def main():
    rows = scan()
    seen = {}
    dupes = []
    for code, fname, line, _ in rows:
        if code in seen:
            dupes.append((code, seen[code], f'{fname}:{line}'))
        seen[code] = f'{fname}:{line}'
    if dupes:
        raise SystemExit('duplicate error codes: ' + '; '.join(f'{c} at {a} and {b}' for c, a, b in dupes))

    out = ['# Error codes', '',
           'Generated by `python3 apps-script/build-error-codes.py`. Do not edit by hand.', '',
           'Every failure the backend raises carries one of these. The same code appears in the',
           'app\'s error banner (in square brackets), in the Log tab\'s detail column, and in the',
           'Apps Script execution log, so any one of the three is enough to find the line.', '',
           '**How to read a code:** `TS-<AREA>-<NN>`. The area names the file; the number is one',
           'specific `fail_()` call in it. Search the file for the code string to land on the line.', '',
           '**TikTok codes** appear inside messages as `(TikTok 12052262)`. Those are TikTok\'s own',
           'error numbers, documented at https://partner.tiktokshop.com/docv2/page/error-code .', '',
           '## Areas', '']
    for k, v in AREAS.items():
        out.append(f'- **{k}** — {v}')
    out += ['', '## Flow signals (not faults)', '', '| Code | Where | Meaning |', '| --- | --- | --- |']
    for code, fname, text in FIXED:
        if code.startswith('TS-UNC'):
            continue
        out.append(f'| `{code}` | {fname} | {text} |')
    out += ['', '## Codes', '', '| Code | Where | Message (as raised) |', '| --- | --- | --- |']
    code, fname, text = FIXED[0]
    out.append(f'| `{code}` | {fname} | {text} |')
    for code, fname, line, text in sorted(rows, key=lambda r: (r[0].split('-')[1], int(r[0].split('-')[2]))):
        out.append(f'| `{code}` | {fname}:{line} | {text.replace("|", "/")} |')
    out.append('')
    OUT.write_text('\n'.join(out))
    print(f'wrote {OUT.name} — {len(rows)} coded sites, {len(FIXED)} fixed entries')


if __name__ == '__main__':
    main()
