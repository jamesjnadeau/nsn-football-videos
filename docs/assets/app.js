/* Vermont high school football video archive.
 *
 * Everything renders from docs/data/games.json, which scripts/fetch_games.py
 * builds from NSN's broadcast API. Routing is hash-based so the whole thing
 * works as flat files on GitHub Pages with no server and no build step.
 *
 * Routes:  #/timeline  #/schools  #/school/<slug>  #/game/<id>
 */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var data = null;          // { games: [...] }
  var bySlug = null;        // slug -> { name, slug, games }

  /* ---- helpers ------------------------------------------------------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Broadcast times are stored in UTC; NSN schedules them in Eastern time, so
  // format in that zone to keep a 7pm Friday kickoff on Friday.
  var DATE_FMT = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York'
  });
  var TIME_FMT = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
  });

  function fmtDate(iso) { return DATE_FMT.format(new Date(iso)); }
  function fmtTime(iso) { return TIME_FMT.format(new Date(iso)) + ' ET'; }

  function matchupText(g) {
    return g.teams.length === 2 ? g.away + ' at ' + g.home : g.title;
  }

  function isUpcoming(g) { return new Date(g.date).getTime() > Date.now(); }

  function badges(g) {
    var out = [];
    if (isUpcoming(g)) out.push(el('span', { class: 'badge upcoming', text: 'Upcoming' }));
    if (g.round) out.push(el('span', { class: 'badge playoff', text: g.round }));
    if (g.part) out.push(el('span', { class: 'badge part', text: 'Part ' + g.part }));
    return out;
  }

  /* ---- reusable pieces ----------------------------------------------- */

  function gameCard(g, opts) {
    opts = opts || {};
    var matchup = el('p', { class: 'matchup' }, [document.createTextNode(matchupText(g))]);
    badges(g).forEach(function (b) { matchup.appendChild(b); });

    var subParts = [fmtDate(g.date), fmtTime(g.date)];
    if (opts.showOpponentOf) {
      var other = g.teams.filter(function (t) { return t !== opts.showOpponentOf; })[0];
      if (other) subParts.unshift((g.home === opts.showOpponentOf ? 'vs ' : 'at ') + other);
    }

    var thumb = g.thumbnail
      ? el('img', {
          class: 'thumb', src: g.thumbnail, alt: '', loading: 'lazy', decoding: 'async'
        })
      : el('div', { class: 'thumb' });

    // The card is a <li>, not an <a>: it holds two links, and an <a> cannot be
    // nested inside another. The matchup link is "stretched" over the whole card
    // via ::after so the card still clicks through to the game page, and the NSN
    // link sits above it.
    var title = el('a', { class: 'game-link', href: '#/game/' + g.id }, [matchup]);

    return el('li', { class: 'game' }, [
      thumb,
      el('span', { class: 'meta' }, [title, el('p', { class: 'sub', text: subParts.join(' · ') })]),
      nsnLink(g, 'NSN ↗', 'card-nsn')
    ]);
  }

  /* An outbound link to NSN's own page for a broadcast.
   *
   * Deliberately rel="noopener" and NOT "noreferrer": NSN should be able to see
   * that the visit came from here and attribute it. Their page is also where
   * their display advertising runs, which this site does not reproduce, so
   * sending real traffic there is the point of the link. */
  function nsnLink(g, label, cls) {
    var a = el('a', {
      class: cls, href: g.nsnUrl, target: '_blank', rel: 'noopener',
      title: 'Open this broadcast on nsnsports.net'
    }, [document.createTextNode(label)]);
    // The card behind it navigates to the local game page; this must not.
    a.addEventListener('click', function (ev) { ev.stopPropagation(); });
    return a;
  }

  /** Render games grouped into season sections, newest season first. */
  function seasonSections(games, opts) {
    opts = opts || {};
    var frag = document.createDocumentFragment();
    if (!games.length) {
      frag.appendChild(el('p', { class: 'empty', text: opts.emptyText || 'No games match that search.' }));
      return frag;
    }
    var seasons = [];
    var groups = {};
    games.forEach(function (g) {
      if (!groups[g.season]) { groups[g.season] = []; seasons.push(g.season); }
      groups[g.season].push(g);
    });
    seasons.sort(function (a, b) { return b - a; });

    seasons.forEach(function (s) {
      var list = el('ul', { class: 'game-list' });
      groups[s].forEach(function (g) { list.appendChild(gameCard(g, opts)); });
      frag.appendChild(el('section', { class: 'season' }, [
        el('h2', { html: s + ' season <span>' + groups[s].length + ' game' + (groups[s].length === 1 ? '' : 's') + '</span>' }),
        list
      ]));
    });
    return frag;
  }

  /* ---- views ---------------------------------------------------------- */

  function timelineView() {
    // Default to games that have actually aired: an upcoming fixture has no
    // video to watch yet, so it does not belong at the top of an archive.
    var state = { q: '', season: 'all', when: 'past' };

    var search = el('input', {
      type: 'search', placeholder: 'Search team, matchup or round…', 'aria-label': 'Search games'
    });

    var whenSel = el('select', { 'aria-label': 'Filter by whether the game has aired' });
    [['past', 'Past games'], ['upcoming', 'Upcoming games'], ['all', 'Past + upcoming']]
      .forEach(function (o) {
        whenSel.appendChild(el('option', { value: o[0], text: o[1] }));
      });
    whenSel.value = state.when;

    var seasonSel = el('select', { 'aria-label': 'Filter by season' });
    seasonSel.appendChild(el('option', { value: 'all', text: 'All seasons' }));
    uniqueSeasons().forEach(function (s) {
      seasonSel.appendChild(el('option', { value: String(s), text: s + ' season' }));
    });

    var count = el('span', { class: 'count' });
    var results = el('div');

    function apply() {
      var q = state.q.trim().toLowerCase();
      var games = data.games.filter(function (g) {
        if (state.when === 'past' && isUpcoming(g)) return false;
        if (state.when === 'upcoming' && !isUpcoming(g)) return false;
        if (state.season !== 'all' && String(g.season) !== state.season) return false;
        if (!q) return true;
        return (g.title + ' ' + g.teams.join(' ') + ' ' + g.round).toLowerCase().indexOf(q) !== -1;
      });
      count.textContent = games.length + ' of ' + data.games.length + ' games';
      results.innerHTML = '';
      results.appendChild(seasonSections(games, { emptyText: emptyTextFor(state) }));
    }

    search.addEventListener('input', function () { state.q = search.value; apply(); });
    whenSel.addEventListener('change', function () { state.when = whenSel.value; apply(); });
    seasonSel.addEventListener('change', function () { state.season = seasonSel.value; apply(); });

    render([
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Game timeline' }),
        el('p', { text: 'Vermont high school football broadcasts from NSN, newest first.' })
      ]),
      el('div', { class: 'controls' }, [search, whenSel, seasonSel, count]),
      results
    ]);
    apply();
  }

  /** Say why the list is empty, rather than always blaming the search box. */
  function emptyTextFor(state) {
    if (state.q.trim()) return 'No games match that search.';
    if (state.when === 'upcoming') return 'No upcoming games are scheduled right now.';
    return 'No games to show.';
  }

  function schoolsView() {
    var schools = Object.keys(bySlug).map(function (s) { return bySlug[s]; });
    schools.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var search = el('input', {
      type: 'search', placeholder: 'Find a school…', 'aria-label': 'Search schools'
    });
    var count = el('span', { class: 'count' });
    var grid = el('ul', { class: 'school-grid' });

    function apply() {
      var q = search.value.trim().toLowerCase();
      var shown = schools.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1; });
      count.textContent = shown.length + ' school' + (shown.length === 1 ? '' : 's');
      grid.innerHTML = '';
      if (!shown.length) {
        grid.appendChild(el('li', { class: 'empty', text: 'No schools match that search.' }));
        return;
      }
      shown.forEach(function (s) {
        grid.appendChild(el('li', {}, [
          el('a', { class: 'school-card', href: '#/school/' + s.slug }, [
            el('span', { class: 'name', text: s.name }),
            el('span', { class: 'n', text: s.games.length + ' game' + (s.games.length === 1 ? '' : 's') })
          ])
        ]));
      });
    }

    search.addEventListener('input', apply);

    render([
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Browse by school' }),
        el('p', { text: 'Pick a program to see every one of its broadcasts, season by season.' })
      ]),
      el('div', { class: 'controls' }, [search, count]),
      grid
    ]);
    apply();
  }

  function schoolView(slug) {
    var school = bySlug[slug];
    if (!school) return notFound('No school with that name is in the archive.');

    var seasons = {};
    school.games.forEach(function (g) { seasons[g.season] = true; });
    var spanText = Object.keys(seasons).sort();
    var opponents = {};
    school.games.forEach(function (g) {
      g.teams.forEach(function (t) { if (t !== school.name) opponents[t] = (opponents[t] || 0) + 1; });
    });
    var topOpp = Object.keys(opponents).sort(function (a, b) { return opponents[b] - opponents[a]; }).slice(0, 3);

    var bits = [school.games.length + ' broadcast' + (school.games.length === 1 ? '' : 's')];
    if (spanText.length === 1) bits.push(spanText[0] + ' season');
    else if (spanText.length > 1) bits.push(spanText[0] + '–' + spanText[spanText.length - 1]);
    // A "most often vs" line only says anything once there are a few games.
    if (school.games.length >= 4 && topOpp.length) bits.push('most often vs ' + topOpp.join(', '));

    var head = el('div', { class: 'page-head' }, [
      el('h1', { text: school.name }),
      el('p', { text: bits.join(' · ') })
    ]);

    render([
      el('a', { class: 'back-link', href: '#/schools', text: '← All schools' }),
      head,
      seasonSections(school.games, { showOpponentOf: school.name })
    ]);
  }

  function gameView(id) {
    var g = data.games.filter(function (x) { return x.id === id; })[0];
    if (!g) return notFound('That game is not in the archive.');

    var facts = el('ul', { class: 'detail-facts' }, [
      el('li', { html: '<b>Date</b> ' + fmtDate(g.date) + ', ' + fmtTime(g.date) }),
      el('li', { html: '<b>Season</b> ' + g.season }),
      g.round ? el('li', { html: '<b>Round</b> ' + g.round }) : null,
      g.source ? el('li', { html: '<b>Broadcast by</b> ' + g.source }) : null
    ]);

    var teamLinks = el('p', {}, []);
    g.teams.forEach(function (t, i) {
      if (i) teamLinks.appendChild(document.createTextNode(' · '));
      teamLinks.appendChild(el('a', { href: '#/school/' + slugify(t), text: 'All ' + t + ' games' }));
    });

    var kids = [
      el('a', { class: 'back-link', href: backTarget(), text: '← Back' }),
      el('div', { class: 'page-head' }, [
        el('h1', { text: matchupText(g) }),
        el('p', { text: g.title })
      ])
    ];

    if (isUpcoming(g)) {
      kids.push(el('p', { class: 'note', text: 'This game has not aired yet. The player opens once NSN starts the broadcast.' }));
    }
    if (g.embedUrl) {
      kids.push(el('iframe', {
        class: 'player', src: g.embedUrl, title: matchupText(g),
        allow: 'fullscreen', allowfullscreen: 'true', loading: 'lazy', referrerpolicy: 'no-referrer-when-downgrade'
      }));
    }
    kids.push(facts);
    if (g.requiresLogin) {
      kids.push(el('p', { class: 'note', text: 'NSN requires a subscription or access pass to watch this broadcast.' }));
    }
    kids.push(el('p', {}, [nsnLink(g, 'Watch on NSN Sports ↗', 'btn')]));
    kids.push(teamLinks);

    render(kids);
  }

  function notFound(msg) {
    render([
      el('div', { class: 'page-head' }, [el('h1', { text: 'Not found' }), el('p', { text: msg })]),
      el('a', { class: 'btn', href: '#/timeline', text: 'Back to the timeline' })
    ]);
  }

  /* ---- plumbing ------------------------------------------------------- */

  var lastListRoute = '#/timeline';

  function backTarget() { return lastListRoute; }

  function uniqueSeasons() {
    var seen = {};
    data.games.forEach(function (g) { seen[g.season] = true; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }

  function render(nodes) {
    view.innerHTML = '';
    nodes.forEach(function (n) { if (n) view.appendChild(n); });
  }

  function indexSchools() {
    bySlug = {};
    data.games.forEach(function (g) {
      g.teams.forEach(function (name, i) {
        var slug = g.teamSlugs[i] || slugify(name);
        if (!bySlug[slug]) bySlug[slug] = { name: name, slug: slug, games: [] };
        bySlug[slug].games.push(g);
      });
    });
  }

  function setTab(name) {
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function route() {
    var hash = location.hash || '#/timeline';
    var parts = hash.replace(/^#\/?/, '').split('/');

    if (parts[0] === 'school' && parts[1]) {
      setTab('schools');
      schoolView(decodeURIComponent(parts[1]));
    } else if (parts[0] === 'schools') {
      lastListRoute = hash;
      setTab('schools');
      schoolsView();
    } else if (parts[0] === 'game' && parts[1]) {
      setTab(null);
      gameView(decodeURIComponent(parts[1]));
    } else {
      lastListRoute = '#/timeline';
      setTab('timeline');
      timelineView();
    }
    window.scrollTo(0, 0);
  }

  fetch('data/games.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (json) {
      data = json;
      indexSchools();
      var stamp = document.getElementById('data-stamp');
      if (stamp && json.generated) {
        stamp.textContent = json.count + ' broadcasts indexed · data refreshed ' +
          new Date(json.generated).toLocaleDateString('en-US', { dateStyle: 'medium' });
      }
      window.addEventListener('hashchange', route);
      route();
    })
    .catch(function (err) {
      view.innerHTML = '';
      view.appendChild(el('p', { class: 'empty', text: 'Could not load the game data (' + err.message + ').' }));
    });
})();
