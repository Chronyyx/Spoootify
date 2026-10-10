# Fluid Lyrics — blueprint

Apple Music-style word and syllable fill lyrics for the Spotify desktop client. It's injected straight into `xpui.spa`, with no Spicetify and no dependencies.

```
src/fluid-lyrics.js        UI thread: hooks, song clock, scheduler, DOM, interaction
src/fluid-lyrics.css       visuals; everything that moves is transform/opacity
src/fl-engine.worker.js    worker: fetching, parsing, word-timing synthesis, audio alignment
src/fl-bg.worker.js        worker: WebGL2 album-art background on an OffscreenCanvas
tools/inject.mjs           zip patcher for xpui.spa (inject / --restore / --restart / --devtools)
```

## Install

```
node tools/inject.mjs --restart      # patch + relaunch Spotify (re-run after every Spotify update)
node tools/inject.mjs --restore      # put the original shell back
```

The injector reads `xpui.spa` as a zip. Untouched entries are copied byte for byte with no recompression. It adds `/fluid-lyrics/*` and puts two marked tags in `index.html`. On a vanilla shell it first writes a backup to `xpui.spa.fl-backup`. Re-running it is idempotent.

Click Spotify's lyrics button to open the viewer (Alt+click still opens Spotify's native lyrics). If you switch that takeover off in ⋯, a ✦ button appears next to it, so the viewer can't become unreachable. Clicking a line seeks to it. The mouse wheel scrolls freely and the view stays where you leave it; a **Back to lyrics** pill (or Esc, or clicking a line) springs it back to the live line. Esc steps back one level: menu, then scroll mode, then the viewer.

## 1. Hooking a snapshot-built client

Spotify 1.3.x keeps almost all of its JS in a V8 startup snapshot. There's no readable `xpui.js` left to regex-patch, which is how Spicetify-era mods got `Platform`. Instead the runtime walks the React fiber tree from `#main` once at boot. It picks up `platform`, `registry` and `playerAPI` from component props, and resolves anything else by name from the DI registry (`AuthorizationAPI`, `TokenProvider`). Nothing in Spotify's code is modified, so it survives most client updates.

Data comes from:
- lyrics: `spclient …/color-lyrics/v2` (line-synced)
- true word timing, when it exists, first: Musixmatch `richsync` (word offsets per line, human-synced; the same catalogue Spotify's line lyrics come from). Fetched by the helper's relay through Musixmatch's iOS-app endpoint with an anonymous token cached in `mxm-token.json`, the route the open-source lyrics-plus custom app uses. The web/desktop endpoints hand out a dummy token that returns scrambled decoy lyrics. A repeated whole-`(…)` background line squeezed to under 60 % of its first take reuses that take's timing.
- other word timing: LRCLIB (enhanced LRC or `lyricsfile` word entries), NetEase `yrc`
- fallbacks, in order, when Spotify has no timed lyrics:
  1. LRCLIB exact lookup, then LRCLIB search ranked by name, artist, sync and duration (±4 s)
  2. NetEase Cloud Music (line `lrc` or word `yrc`, credit lines dropped). NetEase sends no CORS headers, so the background helper relays it from `127.0.0.1:47321` (`tools/lyrics-proxy.mjs`): one fixed route, and it answers only the `xpui.app.spotify.com` origin
  3. unsynced text from Spotify, LRCLIB, then lyrics.ovh
- Spotify disables its lyrics button on songs it has no lyrics for. The runtime re-enables it so those songs can still open the viewer.
- note-onset segments and tatums: `spclient …/audio-attributes/v1/audio-analysis`

## 2. Solving word-level timing

When real word or syllable timestamps exist (LRCLIB enhanced LRC or `lyricsfile` words, or Spotify `syllables`), they're used as-is. Otherwise `fl-engine.worker.js` builds them:

1. **Syllabify** each word. A vowel-group splitter handles V|CV and VC|CV splits and folds silent endings: be·lieve, a·live, col·le·ges, hun·dred, wan·ted. Each CJK character or Hangul block counts as one sung syllable.
2. **Prosody weights.** Long vowels and diphthongs are heavier, monosyllabic function words ("the", "to", "and") are lighter, and punctuation adds a breath (`,` < `.`). The last syllable of each line is lengthened, as singers do at phrase ends.
3. **Fit to the line slot, at the song's own tempo.** Vocals get about 97% of the time until the next line. A pre-pass measures how much time *this song* typically gives a line relative to its syllable load (the median over all lines). Lines may stretch the nominal syllable rate that far, clamped to 1.3–4×. Slow songs (gospel, ballads) therefore sing through their slots, while fast songs keep their natural pace and gaps. On Kanye West's "I'll Fly Away", the first line now spans 15.1 s of its 17 s slot instead of 7 s. On the benchmark this is neutral to slightly better (no benchmark song is that slow). and a small share of any leftover time becomes a held final note. These constants were *fitted to human annotations* (see "Timing accuracy" below), not guessed. When LRCLIB's `lyricsfile` gives a real line `end_ms` (one that ends clearly before the next line), that exact vocal end is used instead.
4. **Audio alignment.** Segment attacks (loudness rise × confidence × level) and tatums become onset candidates. Only strong, unambiguous attacks near the estimate become *anchors*, and an anchor is rejected if it would push local tempo outside 0.65×–1.5×. Every syllable between anchors is placed by linear interpolation in proportion to the prosody estimate. The result is that speed is piecewise constant: each fill moves at a steady pace and never stretches jerkily per syllable.
5. **Interludes.** Breaks of 3.8 s or more, and `♪` lines, become Apple's breathing dots.
6. **Ad-libs are a second voice.** Text in parentheses renders as smaller background vocals and is timed *in parallel* with the lead, not in sequence. The lead owns the whole line slot. Each ad-lib group enters on the lead word it follows (at most 0.45 s in, never after a held-note tail) and runs at a natural pace. If it doesn't fit, it enters earlier rather than speeding up.

The source and sync quality show in the ⋯ menu, for example "Smart sync — aligned to audio onsets". All of this runs in a worker. Results are cached (LRU of 40 tracks), and the next queued track is prefetched 8 s into the current one, so track changes are instant.

## 3. Liquid fill without stutter

Each word is a dim base copy with a bright copy layered on top. The bright copy sits inside a clipping window (`.fl-f`, `overflow: hidden`, with a soft gradient mask at its leading edge) whose child (`.fl-fi`) counter-translates by the same amount. The window slides right while the text inside stays put, which reveals the word with a feathered edge.

- **Only `transform` animates.** It uses percentage translates, so there's no measuring and no layout. The edge mask is static and rasterised once.
- **One shared timeline per line.** Every animation in a line (fill, counter-fill, lift, letter wave, glow) starts at the line start and lasts the line's length. Each word's own timing lives in its keyframe offsets: it holds at "unfilled" until its moment, then follows one keyframe per syllable boundary, so each syllable fills at its own speed. This came out of profiling. With per-word start times, every word's start cost main-thread frames to hand the animation to the compositor, which measured about 58 style recalcs/s. With one batch start per line it measured about 1/s.
- **Scheduled against the compositor clock.** Spotify's `(positionAsOfTimestamp, timestamp)` is mapped into the `performance.now()` domain, which is the clock `document.timeline` and the compositor use. Each line's animations get an absolute `startTime`, and their `playbackRate` follows playback speed. Fills are not driven by `requestAnimationFrame` or timers, so a busy main thread can't make them stutter or drift. The next line is pre-armed so it starts on the exact frame.
- **One transform animation per element.** Chromium can't composite two animations competing for the same property on the same element. Once anything falls back to main-thread ticking, *every* running animation gets restyled each frame. The interlude dots therefore use separate nested layers: CSS scale-in → scripted end collapse → CSS breathing → per-dot opacity.
- **No permanent GPU layers.** Resting states use 2D `translateX/Y`, never `translate3d`. A 3D transform permanently promotes an element to its own GPU layer, and doing that for every word's hidden fill layer put **2,582 layers** on the page, which made every frame after a click cost 70–115 ms of layerize/commit/paint. With 2D resting transforms, only elements that are actually animating get promoted: 216 layers with the viewer open, fewer than Spotify's own 234.
- **Nothing is born invisible.** Chromium won't composite an animation whose target is invisible when it's created (`kAnimationHasNoVisibleChange`) and then ticks it on the main thread for its whole life. So the fill layer is never `opacity: 0` (its own `translate(-100%)` hides it), and interlude dots are only animated once their scale-in has made them visible.
- **Re-timing is free.** Seek, pause, speed change and the user offset only update `startTime` / `currentTime` on existing animations; nothing is rebuilt. A 2 s drift check re-anchors only if the player's clock disagrees by more than 35 ms.
- **Held notes.** Long words (≥ 1 s) get a per-letter lift-and-swell wave plus a glow, done as an opacity animation on a pre-rendered text-shadow layer so the glow is never re-rasterised. Every word rises slightly as it's sung and settles back down when its line ends.

## 4. Lag-free UI

- **No per-frame JavaScript.** The main thread only wakes at line boundaries (one `setTimeout`), on player events, and every 2 s for the drift check.
- **Workers do the heavy lifting.** Network, JSON parsing (the analysis payload is about 450 KB), syllabification and alignment run in `fl-engine`. The background renders in `fl-bg` on an OffscreenCanvas. Measured main-thread cost of the background is about 0 ms/s.
- **Background.** The cover is decoded straight to a pre-blurred 40×40 texture. A WebGL2 shader blends four rotating copies through a two-level domain warp, then boosts saturation, applies a vignette and dithers. It renders at 1/8 of the viewport size and is upscaled by the compositor, so the bilinear upscale *is* the blur and no blur filter ever runs. It's capped at 30 fps, cross-fades between covers, and stops completely when the viewer is hidden. If WebGL or OffscreenCanvas is unavailable, it falls back to compositor-rotated CSS layers.
- **Only visible lines move.** On a line change, only lines that are on screen before or after the move get the spring transition, about 12 of them. Off-screen lines jump silently, and per-line values are cached so unchanged ones are never rewritten. This took line changes from about 100 transitions (80–90% main-thread load for about 0.9 s) down to a single cheap batch.
- **Spotify underneath stops rendering.** While the viewer is open, Spotify's sidebars and main view are invisible but would keep restyling; for example, the home carousels run main-thread `pointer-events` animations. They're set to `content-visibility: hidden` once the open transition finishes, so Chromium skips their style, layout and paint while keeping their state. That's lifted the moment closing starts.
- **Cheap scrolling.** Line offsets are measured in one batched read when lyrics load and on resize; nothing else ever touches layout. Per-line position, distance and stagger are written as *non-inheriting registered custom properties* (`@property --fl-y/--fl-d/--fl-k`), so a line change restyles about 80 line boxes rather than thousands of word spans. Movement uses a physically simulated spring sampled into CSS `linear()` with an Apple-style cascade delay.
- **No hidden compositor traps.** Blur is applied by distance but deliberately not transitioned, because filter transitions can't run on the compositor. Lines aren't permanently `will-change`-promoted: 80 promoted layers made every frame's layerization expensive.
- **Shadow DOM.** The viewer renders inside a shadow root. Every main-thread frame (hover, clicks) re-resolves the style of each running animated element. In Spotify's document, that meant matching against thousands of Spotify CSS rules, about 50 µs per element. In the shadow root only the viewer's own sheet applies: style-recalc time during a mouse sweep fell from 217 to 36 ms/s. Only the next line's timeline is armed at its boundary (absolute start times keep that frame-exact), so fewer animations are live at once.
- **Isolation.** The overlay is `contain: strict` with its own stacking context, so layout and paint inside it never invalidate Spotify's tree. It's built while idle before you open it, so opening is just an opacity/transform transition.
- **Instant buttons.** Press feedback comes from `pointerdown`, not the click round-trip. Clicking a line seeks *optimistically*: the local clock moves in the same frame and the player event confirms afterwards.

## Timing accuracy (ground truth)

Evaluated on **JamendoLyrics MultiLang**, a public research benchmark with human-annotated word onsets: 78 songs, 18,041 words, in English, German, French and Spanish. The engine gets only each line's start time, exactly what Spotify provides, and its predicted word onsets are scored against the annotations. Parameters were tuned on 39 songs and are reported on the other 39 held-out songs.

| approach | median word error | within 300 ms | mean bias |
|---|---|---|---|
| even spread per word (what typical mods do) | 379 ms | 41.6 % | +770 ms (late) |
| even spread per character | 293 ms | 50.7 % | +673 ms (late) |
| **Fluid Lyrics, held-out songs** | **193 ms** | **64.3 %** | **−73 ms** |
| Fluid Lyrics, all 78 songs | 185 ms | 65.8 % | −58 ms |

This is prosody-only. In Spotify, audio-onset anchoring is applied on top, and real word-synced sources are used whenever they exist.

## Measured (Spotify 1.3.4, Chromium 151, 200 Hz display)

| | result |
|---|---|
| Main thread, viewer **closed** | 0.2 ms/s |
| Main thread, viewer open and playing, mouse idle (incl. line changes) | 1.2–1.7 ms/s |
| Main thread, **mouse sweeping over the lyrics** at 32 moves/s while playing | **171 ms/s**, versus 468 ms/s for Spotify alone under the same sweep (920 before Shadow DOM) |
| Style recalcs between line changes | 0–1 per second |
| Composite failures among the viewer's animations | 0 |
| Fill on a 3-syllable word (1079 ms) | 269 samples, 0 backward steps, ≤ 2.3 % per sample, ≤ 2.2 % off the syllable model |
| Viewer ⋯ button, input → paint (hit-verified: 20/20 clicks reached the button) | 16 ms on 18/20 (one frame, the platform floor), 24 and 32 ms on the other two; handler 0.2 ms. Was 48–120 ms with 2,582 layers |
| Platform floor (handler that only repaints a 2 px dot) | 16 ms |
| GPU layers on the page, viewer open | 216 (Spotify alone: 234) |
| Background motion (background-only strip) | mean pixel change 2.1 → 4.8 → 7.2 levels after 1 / 3 / 6 s: slow, continuous drift |
| Background blur | gradient energy 1.03, against 9.24 for the album art itself (about 9× smoother) |
| Spotify's own queue button, same test | median 240 ms (handlers 196 ms) |

Final round on **real playback** (no simulation; "All Falls Down" and "OK"): ⋯ button hit on 20/20 clicks, click → paint 16 ms ×10 and 24 ms ×10; main thread under a mouse sweep 155 ms/s; 145 GPU layers; a 509 ms word filled over 127 samples with no backward step; background drift 2.0 / 4.8 / 7.3 levels after 1 / 3 / 6 s at about 9× less sharpness than the cover.

These were measured with DevTools Performance counters, traces and the Event Timing API against the live client. Playback was simulated by giving only the viewer a "playing" clock, so the real player was never touched.

## Limits

- Synthesized timing is an estimate. It's made of real line starts, a prosody model and audio onsets taken from the *full mix*, not an isolated vocal. It's close and evenly paced, but it isn't ground truth. Real word-synced sources always win when they exist.
- If a song feels consistently early or late on your output device (for example Bluetooth latency), use **⋯ → Sync offset** (±50 ms steps, saved).
- Microsoft Store installs of Spotify keep `xpui.spa` in a read-only location; use the installer from spotify.com.
