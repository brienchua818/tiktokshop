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
  if (!idToken) return null;
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return null;

  var info;
  try { info = JSON.parse(res.getContentText()); } catch (e) { return null; }

  // The token must have been issued for our own client, or any Google ID
  // token from any app would be accepted.
  var expectedClient = prop_('GOOGLE_CLIENT_ID');
  if (expectedClient && info.aud !== expectedClient) return null;
  if (!info.email || info.email_verified === 'false') return null;

  return { email: String(info.email).toLowerCase(), name: info.name || info.email };
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
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // Best effort; never block a request on it.
  try {
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
  } finally {
    lock.releaseLock();
  }
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
