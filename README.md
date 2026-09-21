# Vermont Football Video Archive


A small static site that indexes the Vermont high school football broadcasts
published on [NSN Sports](https://www.nsnsports.net/high-schools/vermont/) and
makes them browsable two ways:

- **Timeline** — broadcasts newest first, grouped by season, with a search box, a
  season filter, and a past/upcoming filter that **defaults to games that have
  aired** (an upcoming fixture has no video behind it yet). Switch it to
  "Upcoming games" or "Past + upcoming" to see scheduled ones.
- **By school** — all 40 programs in the archive, each with its own page listing
  that team's games season by season. These deliberately keep showing upcoming
  fixtures, since with the timeline filtered they are the only place to see when
  a team plays next.

Each game has a detail page with the NSN player embedded, the kickoff time, the
playoff round where there is one, and links through to both schools.

The video itself is hosted and owned by NSN. This site stores no video — only
titles, dates, schools and the links needed to play a broadcast on NSN.

## Respecting NSN

The point of this site is to make NSN's catalogue easier to browse, not to take
income from the people producing it. What embedding their player actually does,
checked against their endpoints:

| Revenue stream | When watched here |
| --- | --- |
| Video pre-roll / mid-roll | **Preserved.** Each broadcast's VMAP defines linear pre-roll and mid-roll breaks loaded through the Google IMA SDK; sponsor-site broadcasts carry live `pubads.g.doubleclick.net` tags that serve inside the embed just as they do on NSN's own page. |
| View tracking | **Preserved.** The VMAP sets `allowStatTracking="true"` and names an analytics stream, so plays from here still count. |
| Sponsor thumbnails | **Preserved.** The card images *are* sponsor creative. |
| Display banner ads | **Lost.** `nsnsports.net` runs Google Ad Manager slots that only render on their own pages. |

So for an ordinary visitor the gap is display advertising and page views.

### The one exception: the marking player

Marking a play needs a readable `currentTime`, and NSN's embed cannot give one —
it is cross-origin and sealed. There is no parent-facing `postMessage` API in
either the embed page or the player bundle; the only message listeners in it are
an hls.js worker and a `setImmediate` polyfill. We can seek into it with `?t=`,
and that is all.

So **signed-in users only** get a plain `<video>` fed by hls.js straight from
NSN's CloudFront CDN, which serves `Access-Control-Allow-Origin: *` on the
variant playlists and segments. It carries no ads. Anonymous visitors — nearly
everyone — still get NSN's own embed with NSN's ads.

This is a deliberate trade the site owner made with the cost in front of them,
and it is kept as narrow as it can be: sign-in is invite-only, `/api/stream`
rejects anonymous requests so it cannot become a public stream endpoint, and
"Watch on NSN Sports" stays on the page either way.

What was **not** done, and must not be: reusing NSN's ad tag from this domain.
Their tag is `iu=/29795821/nsn` with `description_url=https://fan.hudl.com`.
Sending that from here would misdeclare the impression to Google Ad Manager —
the pattern `ads.txt` exists to catch — and could get NSN's whole ad account
flagged, not just these views. An own player with ads is only legitimate if NSN
authorises this domain themselves.

### Rules for anyone changing this code

- **Never rehost.** The marking player streams from NSN's own CDN and caches
  nothing; no copying video, no `download_url`.
- **Never send NSN's ad tag from this domain.** See above.
- **Keep the marking player behind sign-in.** It is the tool, not the way the
  public watches.
- **Keep the outbound links.** Every card and game page links to NSN's page for
  that broadcast, which is where their display ads run.
- **Keep the referrer.** Outbound links use `rel="noopener"` and must never add
  `noreferrer`, so NSN can see and attribute the traffic.
- **Keep the sponsor thumbnails** rather than substituting generic artwork.

None of this substitutes for asking. If this site ever gets real traffic, the
right move is to contact NSN directly — and that is also the route to a player
that can legitimately carry their ads.

## Marking plays

Signed-in visitors can mark when a play starts and ends, and those marks are shared
with everyone. Submissions from new accounts go to a review queue; users granted the
`contributor` role publish directly. Moderators approve markers and hand out that role.

The plays sit in a column beside the video, sized to the left column and scrolling
inside itself, so marking a fortieth play does not lengthen the page or move
anything already on it. *+ Mark a play* is in that column's header, where it stays
put whatever the list is doing, and the form opens **in place of** the list rather
than above or below it: in a column this narrow a form under a long list is off
screen, and one over it shoves every row down the moment it opens. Editing a play
with the ✏ opens the same form the same way.

There are three ways to set a time, and the form starts with the play's number
already in the Label field — one past the highest number used on that broadcast, so a
run of plays is two times and *Save*. Typing over it is expected; a play named by hand
consumes no number.

- **from video** reads the marking player's clock exactly. Signed-in only, since it
  needs the player described above; it is simply absent when NSN's embed is what is on
  screen, rather than present and wrong.
- **from transcript** picks the caption line where the play starts or ends. This was
  the original route, built when the embed was the only player and marks had to be
  anchored to something readable.
- **Typed `m:ss`**, the fallback, and the only option on the handful of pre-2022
  broadcasts with no captions.

*check* seeks the player to whatever is in the field, so a time can be confirmed
before saving.

The transcript is assembled server-side from the broadcast's caption track (VMAP →
master manifest → subtitle playlist → ~757 WebVTT segments) and cached. It is speech
recognition, so proper nouns come through mangled — "Missiskoy" for Missisquoi. It is
for finding a moment, not for reading facts out of.

### The marking player's controls

The bar under the marking player is hand-built, because the browser's native one
cannot be pinned open and nothing can be drawn into it -- and the plays already
marked on a broadcast belong on the timeline, where they show at a glance which
parts of two hours are already covered.

| | |
| --- | --- |
| `←` / `→` | back / forward 5 seconds |
| `↑` / `↓` | volume |
| space, `k` | play / pause |
| `m`, `f` | mute, fullscreen |
| `,` / `.` | slower / faster, through 0.25x to 2x |

The keys are ignored while a form field has focus, so typing a label into the
play form never moves the video. The bar fades out a couple of seconds into
playback; the pin button holds it open, and that choice and the playback speed
are both remembered in `localStorage` for the next broadcast.

## How it works

NSN runs on WordPress and renders its broadcast lists client-side from
`ajax.php?action=nsn_schedule`, scoped to a site slug (`nsnvermont` for the
Vermont hub). `scripts/fetch_games.py` pages through that endpoint, keeps the
football broadcasts, parses the two schools out of each title, and writes
`docs/data/games.json`. The site is plain HTML, CSS and JavaScript reading that
one file — no framework, no build step, no server.

```
docs/                   the static site (published by both hosts)
  index.html
  assets/app.js         hash routing + rendering
  assets/auth.js        Netlify Identity wrapper
  assets/styles.css
  data/games.json       generated — do not hand-edit
netlify/
  functions/            the API: markers, stream, review queue, roles, transcripts
                        one path per function -- Netlify routes by path, so two
                        functions sharing one means the second never runs
  lib/                  the logic those functions share, unit-tested
data/
  raw_broadcasts.json   cached API response, so parsing can be reworked offline
scripts/fetch_games.py
test/                   node --test over netlify/lib
```

### Hosting

The same `docs/` is served from two places:

- **Netlify** runs the full app — `netlify.toml` publishes `docs/` and deploys the
  functions. Netlify Identity must be enabled on the site for sign-in to work.

  Identity delivers invites, password resets and email confirmations as a URL
  fragment (`/#invite_token=…`). `auth.js` captures that fragment synchronously at
  load, strips it from the address bar, and `app.js` renders a set-password form
  before the game data has even arrived. Two things there are easy to get wrong and
  are covered by tests: the token is spent only when the form is submitted, so a
  reload does not burn a single-use link; and `acceptInvite()` / `recoverPassword()`
  do not write the `nf_jwt` cookie the functions authenticate from, so each is
  followed by an explicit `login()`. Where the Identity instance has signup disabled,
  the sign-in form hides the "create an account" path and says so.
- **GitHub Pages** is a read-only mirror. It cannot run functions, so `app.js` probes
  `/api/markers`; where that is missing, the play and commentary panels remove
  themselves and the sign-in link hides. The archive itself works identically.

Transcript builds are capped to the broadcasts in `data/games.json`
(`netlify/lib/games.mjs`). `/api/transcript` and the background build behind it are
necessarily public, and one build is ~757 requests against NSN's CDN, so an
unbounded id would be a way to point real load at them. The check fails open: it is
a brake on abuse, not a security boundary.

Blobs and background functions are used for storage and transcript assembly. Netlify's
Blobs docs say Pro and above while their pricing pages put Functions, Database and Blobs
in the Free tier's credits — worth checking against the account before relying on it.

## Running it

Any static file server works; the site fetches `data/games.json`, so opening
`index.html` straight off the filesystem will not work.

```sh
netlify dev            # full app: functions, Identity, Blobs
# or, archive only, with the marker features hidden:
python3 -m http.server 8000 --directory docs
```

`npm test` runs the unit tests over `netlify/lib` and `docs/assets/auth.js`
(transcript parsing, auth-fragment parsing, marker
validation, role rules, and the compare-and-swap that stops concurrent submissions
overwriting each other); `python3 scripts/test_parse.py` covers the scraper.

## Refreshing the data

```sh
python3 scripts/fetch_games.py                # fetch from NSN, rewrite games.json
python3 scripts/fetch_games.py --from-cache   # re-parse the cached response only
python3 scripts/fetch_games.py --all-sports   # keep soccer etc. as well as football
```

The fetch takes about a minute and is deliberately unhurried — it sleeps between
pages rather than hammering someone else's server. `.github/workflows/refresh-data.yml`
runs it weekly during the season and commits the result.

## Title parsing

NSN's titles are free text, so `fetch_games.py` normalises them:

**NSN names the visiting team first** — `A vs. B` means A travelled to B. That
is not obvious and getting it backwards is silent, so it is pinned down two
ways: three September 2026 games check out against MaxPreps schedules, and
across all 192 seeded playoff titles in the archive the worse seed is listed
first without a single exception — which only holds if the first team is the
visitor, since VPA seeding gives the better seed the home field.

| In the title | Handled as |
| --- | --- |
| `Spaulding vs. Missisquoi` | Spaulding away, Missisquoi home |
| `#3 Colchester vs #2 Lyndon` | seeds stripped, two schools |
| `... - VPA DIV II Semifinal` | a `round` field, not part of the school name |
| `St. Johnsbury vs Colchester 2` | `part: 2` — the second recording of one game |
| `FB - St. Johnsbury vs ...` | leading section tag stripped |
| `Lyndon` / `Lyndon Institute` | merged via the alias table in the script |

Four titles are intentionally left without a school split: the Shrine Maple
Sugar Bowl all-star games, which are Vermont-vs-New-Hampshire rather than two
schools.

When NSN starts using a new format, add a case to `SCHOOL_ALIASES` or
`ROUND_SUFFIX` and re-run with `--from-cache` to check the result without
re-fetching. `python3 scripts/test_parse.py` covers these rules, including the
home/away order, and runs in CI before every scheduled refresh.

## Publishing

`.github/workflows/deploy-pages.yml` publishes `docs/` to GitHub Pages on every
push to `main`, and `refresh-data.yml` calls it after a data refresh that
actually changed something. The first run turns Pages on by itself, so the
repository settings do not need to be touched.

The site lands at `https://jamesjnadeau.github.io/nsn-football-videos/`.
