/* Sign-in, backed by Netlify Identity.
 *
 * The site has no build step, so the Identity library is pulled as an ES module
 * from a CDN the first time anything auth-related is needed. On GitHub Pages
 * there is no Identity instance at all, so every call here resolves to "signed
 * out" rather than throwing -- the mirror has to keep working.
 *
 * Identity delivers invites, password resets and email confirmations as a URL
 * fragment (`/#invite_token=...`). That fragment is captured synchronously at
 * load, below, before anything else can route on it or drop it.
 */
window.NSNAuth = (function () {
  'use strict';

  var MODULE_URL = 'https://cdn.jsdelivr.net/npm/@netlify/identity@2/+esm';
  var modulePromise = null;
  var settingsPromise = null;
  var current = null;          // cached User, or null
  var listeners = [];

  function load() {
    if (!modulePromise) {
      modulePromise = import(MODULE_URL).catch(function (err) {
        console.warn('Identity unavailable:', err && err.message);
        return null;
      });
    }
    return modulePromise;
  }

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(current); } catch (e) { console.error(e); }
    });
  }

  function setUser(u) { current = u || null; notify(); return current; }

  /* ---- auth callback fragments -----------------------------------------
   *
   * We parse these ourselves rather than calling the library's
   * handleAuthCallback(), for two reasons. It consumes the token at page load,
   * so a reload burns a single-use recovery or confirmation link before the
   * user has typed anything; and its invite branch hands back a bare token that
   * the caller has to finish anyway. Parsing here lets the token be spent only
   * when the form is submitted.
   *
   * `#access_token=` is deliberately not handled: it is emitted only by external
   * OAuth providers, and this site has just the email provider enabled. */

  var TOKEN_KINDS = [
    ['invite_token', 'invite'],
    ['recovery_token', 'recovery'],
    ['confirmation_token', 'confirmation'],
    ['email_change_token', 'email_change'],
  ];

  function parseAuthFragment(hash) {
    if (!hash) return null;
    var raw = String(hash).replace(/^#/, '');
    if (raw.indexOf('=') === -1) return null;   // an ordinary route, e.g. #/game/7
    var params = new URLSearchParams(raw);
    for (var i = 0; i < TOKEN_KINDS.length; i++) {
      var token = params.get(TOKEN_KINDS[i][0]);
      if (token) return { kind: TOKEN_KINDS[i][1], token: token };
    }
    var err = params.get('error');
    if (err) {
      return {
        kind: 'error',
        message: params.get('error_description') || err.replace(/_/g, ' '),
      };
    }
    return null;
  }

  // Captured once, at load. Stripping the hash keeps the token out of the
  // address bar, out of browser history and out of anything the user copies.
  var pending = null;
  if (typeof window !== 'undefined' && window.location) {
    pending = parseAuthFragment(window.location.hash);
    if (pending && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  /** acceptInvite() and recoverPassword() establish a session in the library but
   *  never write the nf_jwt cookie -- and both our functions and a later
   *  getUser() authenticate from that cookie. Signing in straight afterwards is
   *  what makes the session real. */
  async function signInAfter(m, user, password) {
    try {
      return setUser(await m.login(user.email, password));
    } catch (_) {
      setUser(null);
      return { user: user, needsSignIn: true };
    }
  }

  return {
    /** Resolves to the signed-in user, or null. Safe to call anywhere. */
    async user() {
      var m = await load();
      if (!m) return null;
      try {
        return setUser(await m.getUser());
      } catch (_) {
        return setUser(null);
      }
    },

    cached: function () { return current; },

    onChange: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },

    /** The invite / recovery / confirmation fragment this page was opened with,
     *  or null. Read synchronously; the module is only fetched if there is one. */
    pending: function () { return pending; },

    /** Called once the callback has been dealt with, so routing resumes. */
    clearPending: function () { pending = null; },

    async login(email, password) {
      var m = await load();
      if (!m) throw new Error('Sign-in is not available on this version of the site.');
      return setUser(await m.login(email, password));
    },

    async signup(email, password, name) {
      var m = await load();
      if (!m) throw new Error('Sign-up is not available on this version of the site.');
      // Identity emails a confirmation link unless autoconfirm is on, in which
      // case this also signs them in. Either way, re-read rather than assume.
      await m.signup(email, password, name ? { full_name: name } : undefined);
      return this.user();
    },

    /** Finish an invite: set the password, sign in, then record a display name. */
    async acceptInvite(token, password, name) {
      var m = await load();
      if (!m) throw new Error('Sign-in is not available on this version of the site.');
      var user = await m.acceptInvite(token, password);
      var result = await signInAfter(m, user, password);
      if (name && !result.needsSignIn) {
        try {
          setUser(await m.updateUser({ data: { full_name: name } }));
        } catch (_) { /* the account exists either way; a name can wait */ }
      }
      return result;
    },

    /** Finish a password reset: spend the recovery token, then sign in. */
    async resetPassword(token, password) {
      var m = await load();
      if (!m) throw new Error('Sign-in is not available on this version of the site.');
      var user = await m.recoverPassword(token, password);
      return signInAfter(m, user, password);
    },

    /** Confirm a new address or a new account; this one sets the cookie itself. */
    async confirmEmail(token) {
      var m = await load();
      if (!m) throw new Error('Sign-in is not available on this version of the site.');
      return setUser(await m.confirmEmail(token));
    },

    async recover(email) {
      var m = await load();
      if (!m) throw new Error('Password recovery is not available on this version of the site.');
      return m.requestPasswordRecovery(email);
    },

    /** Identity's instance settings, or null where there is no instance. */
    settings: function () {
      if (!settingsPromise) {
        settingsPromise = load().then(function (m) {
          return m ? m.getSettings() : null;
        }).catch(function () { return null; });
      }
      return settingsPromise;
    },

    /** Roles arrive as an array; tolerate the older single-string shape too. */
    roles: function (u) {
      u = u || current;
      if (!u) return [];
      var many = Array.isArray(u.roles) ? u.roles : [];
      var one = (typeof u.role === 'string' && u.role) ? [u.role] : [];
      return many.concat(one).filter(function (v, i, a) { return a.indexOf(v) === i; });
    },

    is: function (role, u) { return this.roles(u).indexOf(role) !== -1; },
    canPublish: function (u) { return this.is('contributor', u) || this.is('moderator', u); },

    _parseFragment: parseAuthFragment,
  };
})();
