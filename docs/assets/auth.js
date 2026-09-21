/* Sign-in, backed by Netlify Identity.
 *
 * The site has no build step, so the Identity library is pulled as an ES module
 * from a CDN the first time anything auth-related is needed. On GitHub Pages
 * there is no Identity instance at all, so every call here resolves to "signed
 * out" rather than throwing -- the mirror has to keep working.
 */
window.NSNAuth = (function () {
  'use strict';

  var MODULE_URL = 'https://cdn.jsdelivr.net/npm/@netlify/identity@2/+esm';
  var modulePromise = null;
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

    async logout() {
      var m = await load();
      if (m) { try { await m.logout(); } catch (_) { /* cookies are cleared regardless */ } }
      return setUser(null);
    },

    async recover(email) {
      var m = await load();
      if (!m) throw new Error('Password recovery is not available on this version of the site.');
      return m.requestPasswordRecovery(email);
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
  };
})();
