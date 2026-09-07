/**
 * Who is allowed to do what.
 *
 * Anyone with a Google account can sign in — that is deliberate, and it is
 * also how work gets attributed, since files are named after the person who
 * created them.
 *
 * But signing in is not permission to act. This app pushes products to live
 * TikTok shops, so a stranger who finds the URL must not be able to list
 * anything. A first-time signer is recorded as `pending` and can do nothing
 * until an admin changes their role in the Users tab.
 *
 * The allowlist lives in the Sheet on purpose: Brien can edit it himself,
 * without a deploy and without asking anyone.
 */

/** The signed-in Google account, or '' when the web app is open anonymously. */
function currentEmail_() {
  // getActiveUser() is populated for accounts in the same domain; for other
  // Google accounts getEffectiveUser() is the deploying user, so it is NOT a
  // safe identity source. The frontend therefore sends a verified Google ID
  // token, which is what verifyIdToken_ checks.
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/**
 * Verify a Google ID token and return the identity it proves.
 *
 * The frontend signs the user in with Google and forwards the ID token. It is
 * verified against Google's tokeninfo endpoint rather than decoded locally, so
 * a forged token cannot pass — decoding a JWT without checking its signature
 * would make the whole allowlist decorative.
 */
function verifyIdToken_(idToken) {
  if (!idToken) {
    return refuse_('NO_TOKEN', 'Sign in with Google to continue.');
  }

  var res;
  try {
    res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
  } catch (e) {
    // Google unreachable is not the caller's fault, and telling them to sign
    // in again sends them round a loop that cannot terminate.
    return refuse_('GOOGLE_UNREACHABLE',
      'Could not reach Google to check your sign-in. Try again in a moment.');
  }

  if (res.getResponseCode() !== 200) {
    return refuse_('TOKEN_REJECTED',
      'Your Google sign-in has expired. Sign in again.');
  }

  var info;
  try {
    info = JSON.parse(res.getContentText());
  } catch (e) {
    return refuse_('TOKEN_UNREADABLE', 'Google returned a sign-in we could not read.');
  }

  // The token must have been issued for OUR client.
  //
  // This check fails CLOSED. It used to be skipped when GOOGLE_CLIENT_ID was
  // unset, which meant a half-configured deployment accepted a Google ID token
  // from any app on the internet — anyone could mint one against their own
  // client and be treated as a signed-in user. A backend that cannot say who
  // it is must refuse everyone, not everyone's token.
  //
  // Both refusals below name the configuration, because the alternative is a
  // sign-in screen that loops with no way to tell why. Neither leaks anything:
  // a client id is published inside the app's own JavaScript, and the message
  // says nothing about the person holding the token.
  var expectedClient = googleClientId_();
  if (!expectedClient) {
    return refuse_('BACKEND_NOT_CONFIGURED',
      'This backend has no Google client id, so it cannot verify sign-ins. ' +
      'Nothing you can fix from here.');
  }
  if (info.aud !== expectedClient) {
    return refuse_('CLIENT_ID_MISMATCH',
      'Signed in with Google, but this backend is configured for a different ' +
      'Google client. The app signed you in as ' + shortClient_(info.aud) +
      ' and the backend expects ' + shortClient_(expectedClient) + '. ' +
      'Run checkSetup for the exact values.');
  }

  if (!info.email) {
    return refuse_('NO_EMAIL', 'That Google account did not return an email address.');
  }
  // Google sends this as the string "false", not a boolean.
  if (String(info.email_verified) === 'false') {
    return refuse_('EMAIL_UNVERIFIED', 'That Google account has an unverified email address.');
  }

  return {
    ok: true,
    email: String(info.email).toLowerCase(),
    name: info.name || info.email
  };
}

/** A refusal carrying why, so the sign-in screen can say something useful. */
/**
 * Sessions issued by this backend, so a stream day never forces a re-sign-in.
 *
 * A Google ID token lives one hour. Verifying one on every call meant every
 * phone was thrown back to the sign-in screen mid-broadcast once an hour,
 * whenever Google's silent renewal did not fire (7 Sep, two phones). So the
 * Google token is verified ONCE, at whoami, and the backend hands back its own
 * token: who, until when, signed with a secret only this script holds. Every
 * later call carries that instead. Fourteen hours covers a factory day and an
 * evening stream; the secret lives in Script Properties and is created on
 * first use, so rotating it (delete the property) signs everyone out.
 *
 * Token shape: base64url(JSON {e: email, n: name, x: expiry ms}) "." hex(HMAC-SHA256)
 */
var SESSION_TTL_MS = 14 * 60 * 60 * 1000;
var SESSION_SECRET_KEY = 'SESSION_SECRET';

function sessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty(SESSION_SECRET_KEY);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(SESSION_SECRET_KEY, secret);
  }
  return secret;
}

function b64urlEncode_(text) {
  return Utilities.base64EncodeWebSafe(text).replace(/=+$/, '');
}

function b64urlDecode_(text) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString();
}

function hmacHex_(text, secret) {
  return Utilities.computeHmacSha256Signature(text, secret).map(function (b) {
    var h = (b & 0xff).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

/** Pure: the token for a payload and secret. Tested against known vectors. */
function signSession_(payload, secret) {
  var body = b64urlEncode_(JSON.stringify(payload));
  return body + '.' + hmacHex_(body, secret);
}

/** Pure: the payload if the token is intact and unexpired, else a refusal. */
function readSession_(token, secret, nowMs) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return refuse_('SESSION_INVALID', 'Your sign-in is not recognised. Sign in again.');
  }
  if (hmacHex_(parts[0], secret) !== parts[1]) {
    return refuse_('SESSION_INVALID', 'Your sign-in is not recognised. Sign in again.');
  }
  var payload;
  try { payload = JSON.parse(b64urlDecode_(parts[0])); } catch (e) {
    return refuse_('SESSION_INVALID', 'Your sign-in is not recognised. Sign in again.');
  }
  if (!payload || !payload.e || !(Number(payload.x) > 0)) {
    return refuse_('SESSION_INVALID', 'Your sign-in is not recognised. Sign in again.');
  }
  if (Number(payload.x) <= nowMs) {
    return refuse_('SESSION_EXPIRED', 'Your sign-in has expired after a long day. Sign in again.');
  }
  return { ok: true, email: String(payload.e).toLowerCase(), name: String(payload.n || ''), expires_at: Number(payload.x) };
}

function issueSession_(user) {
  var expires = Date.now() + SESSION_TTL_MS;
  return {
    session_token: signSession_({ e: user.email, n: user.name || '', x: expires }, sessionSecret_()),
    session_expires_at: new Date(expires).toISOString()
  };
}

function verifySession_(token) {
  return readSession_(token, sessionSecret_(), Date.now());
}

function refuse_(code, message) {
  return { ok: false, code: code, message: message };
}

/**
 * Enough of a client id to compare two by eye, without a wall of base64.
 * These are not secrets — they ship in the frontend — but the full string is
 * 72 characters and unreadable on a phone.
 */
function shortClient_(id) {
  var s = String(id || '');
  if (!s) return '(none)';
  var dash = s.indexOf('-');
  return dash === -1 ? s.slice(0, 12) + '…' : s.slice(0, dash + 7) + '…';
}

function usersAll_() { return readAll_(TAB_USERS); }

function findUser_(email) {
  var target = String(email || '').toLowerCase();
  return usersAll_().filter(function (u) {
    return String(u.email).toLowerCase() === target;
  })[0] || null;
}

/** Seed the owner as admin, so there is always someone who can approve. */
function ensureOwner_() {
  if (findUser_(OWNER_EMAIL)) return;
  appendRows_(TAB_USERS, [[
    OWNER_EMAIL, 'Brien Chua', ROLE_ADMIN,
    new Date().toISOString(), '', 'system', 'Seeded owner'
  ]]);
}

/**
 * Resolve an identity to a user record, registering a newcomer as pending.
 *
 * Registering rather than rejecting outright is what makes approval possible:
 * Brien sees the person appear in the Users tab and flips their role, instead
 * of having to be told an email address out of band.
 */
function resolveUser_(identity) {
  ensureOwner_();
  var found = findUser_(identity.email);

  if (!found) {
    appendRows_(TAB_USERS, [[
      identity.email, identity.name, ROLE_PENDING,
      new Date().toISOString(), new Date().toISOString(), '', 'Awaiting approval'
    ]]);
    logEvent_(identity.email, 'first_sign_in', '', identity.name + ' — awaiting approval', 'pending');
    return { email: identity.email, name: identity.name, role: ROLE_PENDING };
  }

  touchLastSeen_(identity.email);
  return {
    email: String(found.email).toLowerCase(),
    name: found.name || identity.name,
    role: String(found.role || ROLE_PENDING).toLowerCase()
  };
}

function touchLastSeen_(email) {
  // Best effort: skipped rather than blocking a livestream push to record a
  // timestamp. See Lock.gs for why this does not take the lock directly.
  withScriptLockOptional_(5000, function () {
    var sh = sheet_(TAB_USERS);
    var last = sh.getLastRow();
    if (last < 2) return;
    var emails = sh.getRange(2, 1, last - 1, 1).getValues();
    var target = String(email).toLowerCase();
    for (var i = 0; i < emails.length; i++) {
      if (String(emails[i][0]).toLowerCase() === target) {
        sh.getRange(i + 2, 5).setValue(new Date().toISOString());
        return;
      }
    }
  });
}

function canList_(user) {
  return user && (user.role === ROLE_ADMIN || user.role === ROLE_LISTER);
}

function isAdmin_(user) {
  return user && user.role === ROLE_ADMIN;
}

/**
 * A filename-safe version of a person's name.
 *
 * Files are saved under the creator's name, so this has to cope with whatever
 * a Google profile contains — accents, punctuation, unusual spacing.
 */
function safeName_(name) {
  return String(name || 'unknown')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60) || 'unknown';
}
