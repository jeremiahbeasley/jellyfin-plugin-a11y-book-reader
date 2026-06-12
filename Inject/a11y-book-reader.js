'use strict';

if (typeof window.a11yBookReader === 'undefined') {
    window.a11yBookReader = {

        _currentItemId: null,
        _spine: [],
        _chapterIndex: 0,
        _pendingScrollFraction: null,
        _pendingPara: null,
        _pendingQuote: null,
        _pendingQuoteOrdinal: 0,
        _pendingQuoteTerm: null,
        _ttsStartPara: null,   // restored Position: where Play resumes reading
        _ttsSaveTimer: null,   // 10s interval persisting the spoken position
        _piperLastAbs: null,   // last highlighted abs char offset (Piper manifest)
        _piperPoll: null,      // interval polling the timing manifest
        // Navigation (Phase 3 book map)
        _nav: null,            // {Toc, Landmarks, PageList} from the server
        _navStack: [],         // locators to return to after link/TOC jumps
        _pendingAnchor: null,  // fragment id to land on after a chapter load
        // Display settings — server-synced, cross-device
        _ds: null,
        _dsSaveTimer: null,
        _dsDefaults: {
            FontFamily: 'publisher', FontSizePct: 100, LineHeightPct: 150,
            LetterSpacing: 0, WordSpacing: 0, ParaSpacingPct: 100,
            MarginPct: 6, Align: 'left', Theme: 'light',
            CustomFg: '#1a1a1a', CustomBg: '#fafaf7',
            HlBg: '#ffd700', HlFg: '#1a1a1a',
            ReducedMotion: false, ViewMode: 'chapter', Ruler: false, TtsRatePct: 100,
            NavUnit: 'chapter'
        },
        _scrollSaveTimer: null,
        // Reading view state (Phase 1)
        _viewMode: 'chapter',    // 'page' | 'chapter' | 'scroll' (full-book)
        _navUnit: 'chapter',     // rotor: what Prev/Next jumps by
        // 3-way view-mode cycle: page (CSS columns) → chapter (scroll one
        // chapter, chapter-by-chapter) → scroll (full-book continuous) → page.
        _modeMeta: {
            page:    { icon: 'auto_stories', label: 'Page',    next: 'chapter' },
            chapter: { icon: 'view_day',     label: 'Chapter', next: 'scroll' },
            scroll:  { icon: 'view_stream',  label: 'Scroll',  next: 'page' }
        },
        _page: 0,
        _pageCount: 1,
        _pageStep: 0,
        _rulerOn: false,
        _immersive: false,
        _enterAtEnd: false,      // entering a chapter backwards lands on its last page
        _reducedMotion: false,
        _readButtonItem: null,   // the item id the read button was injected for
        _readButton: null,       // reference to the injected button element
        _lastFocused: null,      // element to restore focus to on close

        // TTS state
        _ttsUtterance: null,
        _ttsPlaying: false,
        _ttsPaused: false,
        _ttsContinuous: false,   // true while auto-advancing through chapters
        _ttsRate: 1.0,
        _ttsVoiceURI: '',
        _ttsFullText: '',        // full chapter text for current utterance
        _ttsCharOffset: 0,       // absolute char offset into _ttsFullText where current utterance starts
        _ttsLastBoundary: 0,     // last charIndex from onboundary (relative to current utterance start)
        _ttsOffsetMap: [],       // [{node, absStart, absEnd}] mapping char offsets → iframe text nodes
        _piperAudio: null,       // HTMLAudioElement when Piper backend is active
        _piperAudioEl: null,     // persistent <audio> unlocked inside a user gesture (iOS autoplay policy)
        _piperXhr: null,         // in-flight XHR for Piper synthesis (for cancellation)

        // Estimated-highlight ticker: drives word highlighting on platforms
        // whose speech APIs deliver no word-boundary events (iOS/TV browsers,
        // TV built-in voices). Yields to real onboundary events when they fire.
        _hlTicker: null,         // setInterval id
        _hlTickBase: 0,          // abs char offset when the ticker (re)started
        _hlTickStart: 0,         // wall-clock ms when the ticker (re)started
        _hlTickLast: null,       // abs char offset of the last highlighted word
        _hlTickRate: 1.0,        // chars/sec multiplier in effect
        _ttsBoundarySeen: false, // real onboundary events are arriving

        // TV platform TTS state (Samsung Tizen / LG webOS)
        _tizenTtsId: null,
        _webosSubId: 0,

        // ── Initialisation ──────────────────────────────────────────────────

        init: function () {
            this._watchNavigation();
            this._handleCurrentPage();
            // Trigger Chrome's async voice loading early; repopulate the select if open when they arrive
            if (typeof window.speechSynthesis !== 'undefined') {
                window.speechSynthesis.getVoices();
                window.speechSynthesis.addEventListener('voiceschanged', function () {
                    window.a11yBookReader._populateVoices();
                });
            }
        },

        _watchNavigation: function () {
            var self = this;
            // hashchange covers Jellyfin's hash-based SPA routing (#/details?id=...)
            window.addEventListener('hashchange', function () {
                if (document.getElementById('abr-overlay')) return;
                setTimeout(function () { self._handleCurrentPage(); }, 400);
            });
            // popstate: Android/TV back button closes reader; otherwise handle SPA nav
            window.addEventListener('popstate', function () {
                if (document.getElementById('abr-overlay')) {
                    // Back exits immersive mode first; only a second back closes
                    if (self._immersive) {
                        self._setImmersive(false);
                        history.pushState({ abrOpen: true }, '');
                        return;
                    }
                    self._closeReader(true); return;
                }
                setTimeout(function () { self._handleCurrentPage(); }, 600);
            });
            document.addEventListener('viewshow', function () {
                if (document.getElementById('abr-overlay')) return;
                setTimeout(function () { self._handleCurrentPage(); }, 400);
            });
            var origPush = history.pushState;
            history.pushState = function () {
                origPush.apply(history, arguments);
                if (document.getElementById('abr-overlay')) return;
                setTimeout(function () { self._handleCurrentPage(); }, 600);
            };
        },

        _handleCurrentPage: function () {
            var self = this;
            var hash = window.location.hash || '';
            var isDetails = hash.includes('/details') || hash.includes('/item');

            // Reset on non-detail pages so the button is re-injected when returning
            if (!isDetails) {
                self._readButtonItem = null;
                return;
            }

            var params = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
            var itemId = params.get('id');
            // Skip only if the button is already present in the DOM for this exact item
            if (!itemId || (itemId === self._readButtonItem && document.getElementById('abr-read-btn'))) return;

            if (typeof ApiClient === 'undefined') return;

            ApiClient.getItem(ApiClient.getCurrentUserId(), itemId)
                .then(function (item) {
                    if (item.Type === 'Book') {
                        self._injectReadButton(itemId, item.Name);
                    }
                })
                .catch(function () {});
        },

        // ── Read Button ──────────────────────────────────────────────────────

        _injectReadButton: function (itemId, bookName) {
            var self = this;
            // Wait for action buttons area to appear
            var tries = 0;
            var poll = setInterval(function () {
                tries++;
                var container = document.querySelector('.itemDetailPage .itemButtons, .itemDetailPage .detailPagePrimaryButtons, .itemDetailPage .mainDetailButtons');
                if (!container && tries < 20) return;
                clearInterval(poll);
                if (!container) return;

                // Remove any previously injected button
                var existing = document.getElementById('abr-read-btn');
                if (existing) existing.remove();

                var btn = document.createElement('button');
                btn.id = 'abr-read-btn';
                btn.type = 'button';
                btn.className = 'raised emby-button abr-read-button';
                btn.setAttribute('aria-label', 'Read ' + bookName);
                btn.innerHTML = '<span class="material-icons abr-btn-icon" aria-hidden="true">menu_book</span> Read';

                if (document.querySelector('.show-focus')) {
                    btn.classList.add('show-focus');
                }

                btn.addEventListener('click', function () {
                    self._openReader(itemId, bookName);
                });
                btn.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                        e.preventDefault();
                        self._openReader(itemId, bookName);
                    }
                });

                container.appendChild(btn);
                self._readButtonItem = itemId;
                self._readButton = btn;
            }, 200);
        },

        // ── Reader Open / Close ──────────────────────────────────────────────

        _openReader: function (itemId, bookName) {
            var self = this;
            self._lastFocused = document.activeElement;
            self._currentItemId = itemId;

            var readBtn = document.getElementById('abr-read-btn');
            if (readBtn) {
                readBtn.disabled = true;
                readBtn.setAttribute('aria-busy', 'true');
                readBtn.setAttribute('aria-label', 'Opening ' + bookName + '…');
                readBtn.innerHTML = '<span class="abr-btn-spinner" aria-hidden="true"></span><span> Opening…</span>';
            }

            // Settings load first so the reader opens already themed and in
            // the user's view mode (cross-device)
            self._fetchDisplaySettings().then(function () {
                var ds = self._ds;
                self._viewMode = self._normalizeViewMode(ds.ViewMode);
                self._navUnit = self._normalizeNavUnit(ds.NavUnit);
                self._rulerOn = !!ds.Ruler;
                self._ttsRate = (ds.TtsRatePct || 100) / 100;
                self._reducedMotion = ds.ReducedMotion ||
                    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
                return self._fetchSpine(itemId);
            }).then(function (spine) {
                if (readBtn) {
                    readBtn.disabled = false;
                    readBtn.removeAttribute('aria-busy');
                    readBtn.setAttribute('aria-label', 'Read ' + bookName);
                    readBtn.innerHTML = '<span class="material-icons abr-btn-icon" aria-hidden="true">menu_book</span> Read';
                }
                self._spine = spine;
                self._chapterIndex = 0;
                history.pushState({ abrOpen: true }, '');
                self._buildReaderDOM(bookName);
                self._loadAnnotations(itemId); // non-blocking; rotor + button update when it lands
                // Resume at the saved position when one exists; otherwise start at 0
                self._fetchProgress(itemId).then(function (p) {
                    // Locator shape (defensive about JSON casing)
                    var loc = p && (p.Locations || p.locations);
                    var txt = p && (p.Text || p.text);
                    var ch = loc && (typeof loc.Chapter === 'number' ? loc.Chapter : loc.chapter);
                    var fr = loc && (typeof loc.Progression === 'number' ? loc.Progression : loc.progression);
                    var pa = loc && (typeof loc.Position === 'number' ? loc.Position : loc.position);
                    if (typeof ch !== 'number' || ch < 0 || ch >= spine.length) ch = null;
                    if (typeof fr !== 'number' || fr < 0 || fr > 1) fr = 0;
                    if (typeof pa !== 'number' || pa < 0) pa = null;
                    if (ch !== null && (ch > 0 || fr > 0 || pa !== null)) {
                        if (self._viewMode === 'scroll') {
                            self._enterScrollMode(ch, pa, fr);
                        } else {
                            self._pendingScrollFraction = fr;
                            self._pendingPara = pa;
                            self._pendingQuote = txt ? (txt.Highlight || txt.highlight || null) : null;
                            self._loadChapter(ch);
                        }
                        // Prefix the live region so screen readers hear that this is a resume
                        var info = document.getElementById('abr-chapter-info');
                        if (info) info.textContent = 'Resuming at ' + info.textContent;
                    } else if (self._viewMode === 'scroll') {
                        self._enterScrollMode(0, null, 0);
                    } else {
                        self._loadChapter(0);
                    }
                }).catch(function () {
                    if (self._viewMode === 'scroll') self._enterScrollMode(0, null, 0);
                    else self._loadChapter(0);
                });
            }).catch(function () {
                if (readBtn) {
                    readBtn.disabled = false;
                    readBtn.removeAttribute('aria-busy');
                    readBtn.setAttribute('aria-label', 'Read ' + bookName);
                    readBtn.innerHTML = '<span class="material-icons abr-btn-icon" aria-hidden="true">menu_book</span> Read';
                }
                self._showError('Could not open this book. Make sure it is an EPUB file.');
            });
        },

        _closeReader: function (fromPopstate) {
            // Final position save before the overlay (and its iframe) is torn
            // down. Priority: the spot being SPOKEN (live TTS) → the spot Stop
            // captured (_ttsStartPara) → the visual viewport top.
            var closePara = this._currentTtsBlock();
            if (closePara === null) closePara = this._ttsStartPara;
            if (closePara === null || closePara === undefined) closePara = this._firstVisiblePara();
            this._saveProgress(this._chapterIndex, this._currentScrollFraction(), closePara);
            if (this._ttsSaveTimer) { clearInterval(this._ttsSaveTimer); this._ttsSaveTimer = null; }
            if (this._scrollSaveTimer) { clearTimeout(this._scrollSaveTimer); this._scrollSaveTimer = null; }
            this._stopTts();
            var overlay = document.getElementById('abr-overlay');
            if (overlay) overlay.remove();
            document.removeEventListener('keydown', this._keyHandler, true);
            if (!fromPopstate) history.back();
            if (this._lastFocused && this._lastFocused.focus) {
                this._lastFocused.focus();
            }
        },

        _showError: function (msg) {
            var old = document.getElementById('abr-error');
            if (old) old.remove();
            var el = document.createElement('div');
            el.id = 'abr-error';
            el.setAttribute('role', 'alert');
            el.style.cssText = 'margin-top:8px;padding:8px 12px;border-radius:4px;background:rgba(220,53,69,.15);border:1px solid rgba(220,53,69,.5);color:#e05252;font-size:0.9em;';
            el.textContent = msg;
            var btn = document.getElementById('abr-read-btn');
            if (btn && btn.parentNode) {
                btn.parentNode.insertBefore(el, btn.nextSibling);
            } else {
                document.body.appendChild(el);
            }
            setTimeout(function () { if (el.parentNode) el.remove(); }, 8000);
        },

        // ── DOM Construction ─────────────────────────────────────────────────

        _buildReaderDOM: function (bookName) {
            var self = this;
            self._loadSettings();

            var existing = document.getElementById('abr-overlay');
            if (existing) existing.remove();

            var overlay = document.createElement('div');
            overlay.id = 'abr-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'abr-book-title');

            // Toolbar
            var toolbar = document.createElement('div');
            toolbar.id = 'abr-toolbar';
            toolbar.setAttribute('role', 'toolbar');
            toolbar.setAttribute('aria-label', 'Reader controls');

            var titleEl = document.createElement('span');
            titleEl.id = 'abr-book-title';
            titleEl.className = 'abr-title-text';
            titleEl.textContent = bookName;

            var chapterInfo = document.createElement('span');
            chapterInfo.id = 'abr-chapter-info';
            chapterInfo.className = 'abr-chapter-info';
            chapterInfo.setAttribute('aria-live', 'polite');
            chapterInfo.setAttribute('aria-atomic', 'true');

            // TTS controls — always render; Piper is server-side and works without browser speechSynthesis
            var ttsBtn = document.createElement('button');
            ttsBtn.id = 'abr-tts-toggle';
            ttsBtn.type = 'button';
            ttsBtn.className = 'abr-icon-btn';
            ttsBtn.setAttribute('aria-label', 'Play audio');
            ttsBtn.setAttribute('aria-pressed', 'false');
            ttsBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
            ttsBtn.addEventListener('click', function () { self._toggleTts(); });
            // ttsBtn / ttsStopBtn are placed in the bottom bar (audio cluster) below.

            var ttsStopBtn = document.createElement('button');
            ttsStopBtn.id = 'abr-tts-stop';
            ttsStopBtn.type = 'button';
            ttsStopBtn.className = 'abr-icon-btn';
            ttsStopBtn.setAttribute('aria-label', 'Stop audio');
            ttsStopBtn.setAttribute('hidden', '');
            ttsStopBtn.innerHTML = '<span class="material-icons" aria-hidden="true">stop</span>';
            ttsStopBtn.addEventListener('click', function () { self._stopTts(); });

            // Settings — opens the tabbed modal (Text / Page / Audio / Color),
            // which absorbs the old display-settings, TTS-settings, ruler, and
            // view-mode controls. View mode now lives on the Page tab.
            var settingsBtn = document.createElement('button');
            settingsBtn.id = 'abr-settings-btn';
            settingsBtn.type = 'button';
            settingsBtn.className = 'abr-icon-btn';
            settingsBtn.setAttribute('aria-label', 'Settings');
            settingsBtn.setAttribute('aria-expanded', 'false');
            settingsBtn.setAttribute('aria-controls', 'abr-settings');
            settingsBtn.innerHTML = '<span class="material-icons" aria-hidden="true">settings</span>';
            settingsBtn.addEventListener('click', function () { self._openSettingsModal(); });
            toolbar.appendChild(settingsBtn);

            // Book map (TOC / pages / landmarks / go-to)
            var mapBtn = document.createElement('button');
            mapBtn.id = 'abr-bookmap-btn';
            mapBtn.type = 'button';
            mapBtn.className = 'abr-icon-btn';
            mapBtn.setAttribute('aria-label', 'Book navigation');
            mapBtn.setAttribute('aria-expanded', 'false');
            mapBtn.setAttribute('aria-controls', 'abr-bookmap');
            mapBtn.innerHTML = '<span class="material-icons" aria-hidden="true">toc</span>';
            mapBtn.addEventListener('click', function () { self._toggleBookMap(); });
            toolbar.appendChild(mapBtn);

            // Bookmark toggle for the current position (B works reader-wide)
            var bookmarkBtn = document.createElement('button');
            bookmarkBtn.id = 'abr-bookmark-btn';
            bookmarkBtn.type = 'button';
            bookmarkBtn.className = 'abr-icon-btn';
            bookmarkBtn.setAttribute('aria-label', 'Bookmark this position');
            bookmarkBtn.setAttribute('aria-pressed', 'false');
            bookmarkBtn.setAttribute('aria-keyshortcuts', 'b');
            bookmarkBtn.innerHTML = '<span class="material-icons" aria-hidden="true">bookmark_border</span>';
            bookmarkBtn.addEventListener('click', function () { self._toggleBookmark(); });
            toolbar.appendChild(bookmarkBtn);

            // Back: return to the position before the last jump/link
            var backBtn = document.createElement('button');
            backBtn.id = 'abr-back-btn';
            backBtn.type = 'button';
            backBtn.className = 'abr-icon-btn';
            backBtn.setAttribute('aria-label', 'Back to previous reading position');
            backBtn.setAttribute('hidden', '');
            backBtn.innerHTML = '<span class="material-icons" aria-hidden="true">undo</span>';
            backBtn.addEventListener('click', function () { self._goBack(); });
            toolbar.appendChild(backBtn);

            // Immersive (distraction-reduced) mode toggle
            // An action, not a toggle: while "pressed" the toolbar is gone, so
            // aria-pressed could never be perceived (4.1.2)
            var immersiveBtn = document.createElement('button');
            immersiveBtn.id = 'abr-immersive-toggle';
            immersiveBtn.type = 'button';
            immersiveBtn.className = 'abr-icon-btn';
            immersiveBtn.setAttribute('aria-label', 'Hide controls (immersive reading)');
            immersiveBtn.innerHTML = '<span class="material-icons" aria-hidden="true">fullscreen</span>';
            immersiveBtn.addEventListener('click', function () { self._setImmersive(true); });
            toolbar.appendChild(immersiveBtn);

            // Close lives pinned to the overlay's top-right (appended to the
            // overlay below), NOT in the wrapping toolbar — always reachable.
            var closeBtn = document.createElement('button');
            closeBtn.id = 'abr-close';
            closeBtn.type = 'button';
            closeBtn.className = 'abr-icon-btn';
            closeBtn.setAttribute('aria-label', 'Close reader');
            closeBtn.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';
            closeBtn.addEventListener('click', function () { self._closeReader(); });

            toolbar.appendChild(titleEl);
            toolbar.appendChild(chapterInfo);

            // (Audio voice/speed controls now live in the Settings modal's
            // Audio tab — see _buildAudioControls.)

            // Chapter frame
            var contentArea = document.createElement('div');
            contentArea.id = 'abr-content-area';

            var frame = document.createElement('iframe');
            frame.id = 'abr-frame';
            frame.setAttribute('title', bookName + ' — book content');
            frame.setAttribute('sandbox', 'allow-same-origin');
            frame.setAttribute('tabindex', '0');
            contentArea.appendChild(frame);

            // Reading ruler — tinted band over the reading line (pointer-events: none)
            var ruler = document.createElement('div');
            ruler.id = 'abr-ruler';
            ruler.setAttribute('aria-hidden', 'true');
            if (!self._rulerOn) ruler.setAttribute('hidden', '');
            contentArea.appendChild(ruler);

            // Progress ribbon — the bookmark ribbon along the page edge.
            // A progressbar (not a button) until P3 gives it a jump action:
            // a 14px-wide button would fail WCAG 2.5.8 and add a dead tab stop.
            var ribbon = document.createElement('div');
            ribbon.id = 'abr-ribbon';
            ribbon.setAttribute('role', 'progressbar');
            ribbon.setAttribute('aria-label', 'Book progress');
            ribbon.setAttribute('aria-valuemin', '0');
            ribbon.setAttribute('aria-valuemax', '100');
            ribbon.setAttribute('aria-valuenow', '0');
            ribbon.innerHTML = '<span id="abr-ribbon-fill" aria-hidden="true"></span>';
            contentArea.appendChild(ribbon);

            // Immersive escape hatch — always present, faded until focused/hovered
            var showCtrls = document.createElement('button');
            showCtrls.id = 'abr-show-controls';
            showCtrls.type = 'button';
            showCtrls.setAttribute('aria-label', 'Show reader controls');
            showCtrls.setAttribute('hidden', '');
            showCtrls.innerHTML = '<span class="material-icons" aria-hidden="true">fullscreen_exit</span>';
            showCtrls.addEventListener('click', function () { self._setImmersive(false); });
            contentArea.appendChild(showCtrls);

            // Nav bar
            var nav = document.createElement('nav');
            nav.id = 'abr-nav';
            nav.setAttribute('aria-label', 'Chapter navigation');

            var prevBtn = document.createElement('button');
            prevBtn.id = 'abr-prev';
            prevBtn.type = 'button';
            prevBtn.className = 'abr-nav-btn';
            prevBtn.setAttribute('aria-label', 'Previous chapter');
            prevBtn.innerHTML = '<span class="material-icons" aria-hidden="true">chevron_left</span><span class="abr-nav-label"> Previous</span>';
            prevBtn.addEventListener('click', function () { self._navStep(-1); });

            var chapterLabel = document.createElement('span');
            chapterLabel.id = 'abr-chapter-label';
            chapterLabel.className = 'abr-chapter-label';

            // Page / percent readout (live region politely announces position)
            var pageInfo = document.createElement('span');
            pageInfo.id = 'abr-page-info';
            pageInfo.className = 'abr-chapter-label';
            // Page turns announce in paged mode; scrolling stays quiet
            pageInfo.setAttribute('aria-live', self._viewMode === 'page' ? 'polite' : 'off');

            var nextBtn = document.createElement('button');
            nextBtn.id = 'abr-next';
            nextBtn.type = 'button';
            nextBtn.className = 'abr-nav-btn';
            nextBtn.setAttribute('aria-label', 'Next chapter');
            nextBtn.innerHTML = '<span class="abr-nav-label">Next </span><span class="material-icons" aria-hidden="true">chevron_right</span>';
            nextBtn.addEventListener('click', function () { self._navStep(1); });

            var mid = document.createElement('span');
            mid.className = 'abr-nav-mid';
            mid.appendChild(chapterLabel);
            mid.appendChild(pageInfo);

            // Rotor: "Navigate by" — sets what Prev/Next jumps by. A wrapping
            // <label> gives the select its accessible name (2.5.3 label-in-name);
            // it wraps to its own row at narrow widths via CSS.
            var rotorWrap = document.createElement('label');
            rotorWrap.className = 'abr-rotor';
            rotorWrap.id = 'abr-rotor';
            var rotorText = document.createElement('span');
            rotorText.className = 'abr-rotor-label';
            rotorText.textContent = 'Navigate by';
            var rotor = document.createElement('select');
            rotor.id = 'abr-nav-unit';
            rotor.className = 'abr-rotor-select';
            rotor.setAttribute('aria-label', 'Navigate by');
            [['chapter', 'Chapter'], ['page', 'Page'], ['heading', 'Heading'],
             ['paragraph', 'Paragraph'], ['sentence', 'Sentence'], ['bookmark', 'Bookmark']].forEach(function (o) {
                var opt = document.createElement('option');
                opt.value = o[0]; opt.textContent = o[1];
                if (o[0] === self._navUnit) opt.selected = true;
                rotor.appendChild(opt);
            });
            rotor.addEventListener('change', function () { self._setNavUnit(rotor.value); });
            rotorWrap.appendChild(rotorText);
            rotorWrap.appendChild(rotor);
            mid.appendChild(rotorWrap);

            // Audio cluster (Bookshare-style): sentence skip-back · play/pause ·
            // stop · sentence skip-ahead. ttsBtn/ttsStopBtn were created in the
            // toolbar section and are relocated here. Skip uses the sentence
            // navigator (seeks within a playing Piper stream when possible).
            var audioCluster = document.createElement('span');
            audioCluster.className = 'abr-audio-cluster';
            var skipBack = document.createElement('button');
            skipBack.id = 'abr-audio-back';
            skipBack.type = 'button';
            skipBack.className = 'abr-icon-btn';
            skipBack.setAttribute('aria-label', 'Skip back one sentence');
            skipBack.innerHTML = '<span class="material-icons" aria-hidden="true">fast_rewind</span>';
            skipBack.addEventListener('click', function () { self._audioSkip(-1); });
            var skipFwd = document.createElement('button');
            skipFwd.id = 'abr-audio-fwd';
            skipFwd.type = 'button';
            skipFwd.className = 'abr-icon-btn';
            skipFwd.setAttribute('aria-label', 'Skip ahead one sentence');
            skipFwd.innerHTML = '<span class="material-icons" aria-hidden="true">fast_forward</span>';
            skipFwd.addEventListener('click', function () { self._audioSkip(1); });
            audioCluster.appendChild(skipBack);
            audioCluster.appendChild(ttsBtn);
            audioCluster.appendChild(ttsStopBtn);
            audioCluster.appendChild(skipFwd);

            nav.appendChild(prevBtn);
            nav.appendChild(mid);
            nav.appendChild(audioCluster);
            nav.appendChild(nextBtn);
            self._updateNavUnitLabels(); // Prev/Next names reflect the saved unit

            overlay.appendChild(toolbar);
            overlay.appendChild(contentArea);
            overlay.appendChild(nav);
            overlay.appendChild(closeBtn); // pinned top-right via CSS

            // Swipe on the chrome: page in paged mode, chapter in scroll mode
            var touchStartX = 0;
            overlay.addEventListener('touchstart', function (e) {
                touchStartX = e.touches[0].clientX;
            }, { passive: true });
            overlay.addEventListener('touchend', function (e) {
                var dx = e.changedTouches[0].clientX - touchStartX;
                if (Math.abs(dx) > 50) self._turnByPage(dx < 0 ? 1 : -1);
            });

            // Settings modal (tabbed: Text/Page/Audio/Color) + book-map panel,
            // rendered under the menu bar.
            overlay.insertBefore(self._buildSettingsModal(), contentArea);
            overlay.insertBefore(self._buildBookMap(), contentArea);

            document.body.appendChild(overlay);
            self._applyChromeTheme();

            // Voices require the select to be in the live DOM — populate now
            self._populateVoices();

            // Focus management
            this._trapFocus(overlay);
            this._keyHandler = this._onKeyDown.bind(this);
            document.addEventListener('keydown', this._keyHandler, true);

            // TV focus: stamp show-focus on all buttons inside the reader
            this._tvFocusSweep(overlay);

            // Initial focus
            closeBtn.focus();
        },

        // ── Chapter Navigation ───────────────────────────────────────────────

        _loadChapter: function (index) {
            var self = this;

            // Silent cancel: stop audio but preserve _ttsContinuous so auto-advance survives
            self._stopHlTicker();
            self._stopPiperTts();
            if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
            self._ttsPlaying = false;
            self._ttsPaused = false;
            self._ttsUtterance = null;
            self._ttsCharOffset = 0;
            self._ttsFullText = '';
            self._ttsLastBoundary = 0;
            self._ttsOffsetMap = [];
            // Clear the start-hint and the periodic-save timer too: a stale
            // hint from the OLD chapter would misplace the next read, and a
            // leaked interval would keep firing. The resume-open path re-sets
            // the hint in frame.onload after this load.
            self._ttsStartPara = null;
            self._piperLastAbs = null;
            self._cssHl = null; // bound to the old iframe window; recreate for the new doc
            if (self._ttsSaveTimer) { clearInterval(self._ttsSaveTimer); self._ttsSaveTimer = null; }
            self._clearTtsSelection(document.getElementById('abr-frame'));

            var spine = self._spine;
            if (!spine.length) return;

            self._chapterIndex = Math.max(0, Math.min(index, spine.length - 1));
            var chapter = spine[self._chapterIndex];

            var frame = document.getElementById('abr-frame');
            var prevBtn = document.getElementById('abr-prev');
            var nextBtn = document.getElementById('abr-next');
            var chapterInfo = document.getElementById('abr-chapter-info');
            var chapterLabel = document.getElementById('abr-chapter-label');

            if (!frame) return;

            // Update nav state
            var isFirst = self._chapterIndex === 0;
            var isLast = self._chapterIndex === spine.length - 1;
            prevBtn.disabled = isFirst;
            nextBtn.disabled = isLast;
            prevBtn.setAttribute('aria-disabled', isFirst ? 'true' : 'false');
            nextBtn.setAttribute('aria-disabled', isLast ? 'true' : 'false');

            var label = 'Chapter ' + (self._chapterIndex + 1) + ' of ' + spine.length;
            if (chapter.title) label += ': ' + chapter.title;
            chapterInfo.textContent = label;
            chapterLabel.textContent = (self._chapterIndex + 1) + ' / ' + spine.length;

            // Load chapter HTML into iframe. An iframe src can't send auth
            // headers, so pass the token as ?api_key= — the same pattern the
            // TTS <audio> stream uses (the endpoint is no longer anonymous).
            var token = (typeof ApiClient !== 'undefined' && ApiClient.accessToken) ? ApiClient.accessToken() : '';
            var src = '/A11yBookReader/chapter/' + self._currentItemId + '/' + self._chapterIndex +
                (token ? '?api_key=' + encodeURIComponent(token) : '');

            // Persist chapter turns immediately — but not when this load IS the
            // resume jump or a navigation jump (the pending anchor would be
            // clobbered with 0). No text/Position anchor here: the OLD chapter
            // is still in the frame, so any quote grabbed now would be wrong.
            if (self._pendingScrollFraction === null && self._pendingPara === null &&
                self._pendingAnchor === null && self._pendingQuote === null) {
                self._saveProgress(self._chapterIndex, 0, null);
            }
            // Hide the frame until the reader styles and landing are applied —
            // the chapter otherwise paints once with the publisher's CSS and
            // visibly reflows into the user's font/spacing (jarring flash).
            // visibility (not display) so layout still computes for pagination.
            // Safety timer: a chapter that never fires onload must still reveal.
            frame.style.visibility = 'hidden';
            if (self._revealTimer) clearTimeout(self._revealTimer);
            self._revealTimer = setTimeout(function () { frame.style.visibility = ''; }, 2500);
            frame.src = src;

            frame.onload = function () {
                try {
                    self._setupChapterView(frame);
                    self._restoreScrollAndTrack(frame);
                } finally {
                    if (self._revealTimer) { clearTimeout(self._revealTimer); self._revealTimer = null; }
                    frame.style.visibility = '';
                }
                self._tvFocusSweep(document.getElementById('abr-overlay'));
                // Auto-start TTS if continuous reading is active
                if (self._ttsContinuous) {
                    self._updateTtsButtons(true);
                    self._startTts();
                }
            };
        },

        _navigateChapter: function (delta) {
            this._enterAtEnd = (delta < 0 && this._viewMode === 'page');
            this._loadChapter(this._chapterIndex + delta);
        },

        // ── Reading View Engine (Phase 1) ────────────────────────────────────

        // Unified turn: pages within the chapter first, chapters at the edges.
        // Page/viewport movement — used by swipe, tap zones, and keyboard
        // arrows. The Prev/Next buttons go through _navStep (the rotor).
        _turnByPage: function (delta) {
            // Deliberate navigation: Play now starts from where the user moved
            this._navResetTts();
            // Full-book scroll: Prev/Next steps by a viewport; the lazy loader
            // brings in chapter edges, so we never reload the frame here. (The
            // rotor refines what a step means in Track 2.)
            if (this._viewMode === 'scroll') {
                try {
                    var sw = document.getElementById('abr-frame').contentWindow;
                    var sde = sw.document.documentElement;
                    sw.scrollBy({ top: delta * sde.clientHeight * 0.9,
                                  behavior: this._reducedMotion ? 'auto' : 'smooth' });
                } catch (e) {}
                return;
            }
            // Book edges: nothing past the last page of the last chapter,
            // nothing before the first page of the first one.
            var atLastChapter = this._chapterIndex >= this._spine.length - 1;
            var atFirstChapter = this._chapterIndex <= 0;
            if (this._viewMode === 'page') {
                var target = this._page + delta;
                if (target >= 0 && target < this._pageCount) { this._goToPage(target); return; }
                if ((delta > 0 && atLastChapter) || (delta < 0 && atFirstChapter)) return;
                this._navigateChapter(delta);
                return;
            }
            // Scroll mode: page-sized scroll steps, chapter change at the edges
            var frame = document.getElementById('abr-frame');
            try {
                var win = frame.contentWindow, doc = win.document.documentElement;
                var max = doc.scrollHeight - doc.clientHeight;
                var atEdge = delta > 0 ? win.pageYOffset >= max - 2 : win.pageYOffset <= 2;
                if (max <= 0 || atEdge) {
                    if ((delta > 0 && atLastChapter) || (delta < 0 && atFirstChapter)) return;
                    this._navigateChapter(delta); return;
                }
                win.scrollBy({ top: delta * doc.clientHeight * 0.9,
                               behavior: this._reducedMotion ? 'auto' : 'smooth' });
            } catch (e) { this._navigateChapter(delta); }
        },

        // ── Rotor: Prev/Next by the selected unit ────────────────────────────
        // The "Navigate by" select sets _navUnit; the Prev/Next buttons call
        // _navStep, which jumps by that unit. Move inherits TTS state: if it was
        // playing, it keeps reading from the new spot; if stopped, it stays
        // silent (Play later starts there).
        // ◀ Previous / Next ▶ : move by the VIEW MODE — Page→page, Chapter→chapter,
        // Scroll→chapter. Read-aloud follows the new focus.
        _navStep: function (delta) {
            var wasPlaying = this._ttsPlaying || this._ttsContinuous;
            var ch0 = this._chapterIndex;
            if (this._viewMode === 'page') this._navByPage(delta);
            else this._navByChapter(delta);            // chapter + scroll → by chapter
            this._followAudio(wasPlaying, ch0);
        },

        // ⏪ / ⏩ : move by the ROTOR unit ("Navigate by"). Read-aloud follows.
        _audioSkip: function (delta) {
            var wasPlaying = this._ttsPlaying || this._ttsContinuous;
            var ch0 = this._chapterIndex;
            var selfHandled = false;
            switch (this._navUnit) {
                case 'page':      this._navByPage(delta); break;
                case 'heading':   this._navByElement(delta, 'heading'); break;
                case 'paragraph': this._navByElement(delta, 'paragraph'); break;
                case 'sentence':  this._navBySentence(delta); selfHandled = true; break; // self-manages audio
                case 'bookmark':  this._navByBookmark(delta); break;
                case 'chapter':
                default:          this._navByChapter(delta); break;
            }
            if (!selfHandled) this._followAudio(wasPlaying, ch0);
        },

        // Read-aloud follows the focus after any navigation. A chapter change
        // resumes via _loadChapter's onload (so we just keep _ttsContinuous set);
        // an in-chapter move restarts playback from the new position.
        _followAudio: function (wasPlaying, ch0) {
            if (!wasPlaying) return;
            var self = this;
            this._ttsContinuous = true;
            // A page/chapter-mode chapter change reloads the frame and resumes via
            // _loadChapter's onload; give that a moment, then start explicitly if
            // it didn't (covers scroll-mode chapter moves, which don't reload, and
            // any in-chapter move). The guard avoids a double-start.
            var delay = (this._chapterIndex !== ch0) ? 700 : 220;
            setTimeout(function () {
                if (self._ttsPlaying) return;
                self._ttsContinuous = true;
                self._updateTtsButtons(true);
                self._startTts();
            }, delay);
        },

        _setNavUnit: function (unit) {
            this._navUnit = this._normalizeNavUnit(unit);
            if (this._ds) { this._ds.NavUnit = this._navUnit; this._saveDisplaySettings(); }
            this._updateSkipLabels();
            var info = document.getElementById('abr-chapter-info'); // polite live region
            if (info) info.textContent = 'Skip by ' + this._navUnit;
        },

        // Prev/Next announce the view-mode unit; ⏪/⏩ announce the rotor unit.
        _updateNavUnitLabels: function () {
            this._updateNavStepLabels();
            this._updateSkipLabels();
        },
        _updateNavStepLabels: function () {
            var unit = this._viewMode === 'page' ? 'page' : 'chapter';
            var prev = document.getElementById('abr-prev');
            var next = document.getElementById('abr-next');
            if (prev) prev.setAttribute('aria-label', 'Previous ' + unit);
            if (next) next.setAttribute('aria-label', 'Next ' + unit);
        },
        _updateSkipLabels: function () {
            var back = document.getElementById('abr-audio-back');
            var fwd = document.getElementById('abr-audio-fwd');
            if (back) back.setAttribute('aria-label', 'Skip back one ' + this._navUnit);
            if (fwd) fwd.setAttribute('aria-label', 'Skip ahead one ' + this._navUnit);
        },

        // Dedicated page step (rotor=Page, and Prev/Next in Page view). Recomputes
        // the live page count + current page from the RENDERED layout on every
        // press, so a stale _page/_pageCount left behind by a view switch can't
        // misfire a chapter jump — the "switching confuses it" class of bug. In
        // non-page view modes a "page" is a viewport step, handled by _turnByPage.
        _navByPage: function (delta) {
            var frame = document.getElementById('abr-frame');
            var doc = frame && frame.contentDocument;
            if (!doc || !doc.body || this._viewMode !== 'page') return this._turnByPage(delta);
            var w = this._pageStep || frame.clientWidth || 1;
            // Use the cached _pageCount (computed at layout, before any transform —
            // body.scrollWidth is unreliable once the body is translated). But take
            // the CURRENT page from what's ACTUALLY rendered (the transform), so a
            // stale _page from a view switch can't misfire a chapter jump.
            // Include any residual root scroll (focus/selection drift) so the
            // step lands back ON the grid instead of compounding the offset
            var sl = 0;
            try { sl = doc.documentElement.scrollLeft || 0; } catch (e) {}
            var m = (doc.body.style.transform || '').match(/-?\d+(?:\.\d+)?/);
            var curPage = m ? Math.round((Math.abs(parseFloat(m[0])) + sl) / w) : (this._page || 0);
            this._page = Math.max(0, Math.min(curPage, this._pageCount - 1));
            var target = this._page + delta;
            if (target >= 0 && target < this._pageCount) { this._goToPage(target); return; }
            // Genuine chapter edge → adjacent chapter's first/last page.
            if (this._chapterIndex + delta >= 0 && this._chapterIndex + delta < this._spine.length) {
                this._navResetTts();
                this._enterAtEnd = (delta < 0);
                this._navigateChapter(delta);
            }
        },

        _navByChapter: function (delta) {
            this._navResetTts();
            var target = this._chapterIndex + delta;
            if (target < 0 || target >= this._spine.length) return;
            if (this._viewMode === 'scroll') {
                this._chapterIndex = target;
                this._scrollGoToAnchor(target, null);
            } else {
                this._navigateChapter(delta);
            }
            this._updateProgressUI();
        },

        // Block index whose text contains a given char offset (for cumulative
        // element stepping).
        _blockIndexOfOffset: function (offset) {
            if (!offset) return null;
            try {
                var doc = document.getElementById('abr-frame').contentDocument;
                var entry = this._findMapEntry(offset);
                if (!entry) return null;
                var blocks = this._getBlocks(doc);
                for (var i = 0; i < blocks.length; i++) if (blocks[i].contains(entry.node)) return i;
            } catch (e) {}
            return null;
        },

        // Headings (h1–h6) or paragraph-level blocks, prev/next from the current
        // reading position. Past the chapter's elements → adjacent chapter.
        _navByElement: function (delta, kind) {
            // Live spoken offset, captured BEFORE _navResetTts wipes TTS state, so
            // a step while reading aloud starts from where the VOICE is (not the
            // page top — that made it re-read the current paragraph).
            var playingOff = (this._ttsPlaying && !this._ttsPaused)
                ? (this._piperLastAbs != null ? this._piperLastAbs
                   : (this._hlTickLast != null ? this._hlTickLast
                      : this._ttsCharOffset + this._ttsLastBoundary))
                : null;
            this._navResetTts();
            var frame = document.getElementById('abr-frame');
            var doc = frame && frame.contentDocument;
            if (!doc) return;
            if (this._viewMode === 'scroll') return this._navByElementScroll(delta, kind, frame, doc);

            this._ensureOffsetMap();
            var blocks = this._getBlocks(doc);
            // Advance from the last highlighted block so consecutive presses step
            // forward/back, re-anchoring to the first visible block when the
            // reader has moved ahead — same cumulative logic as sentence nav.
            var visPara = this._firstVisiblePara(); if (visPara == null) visPara = 0;
            var visOff = this._paraCharOffset(visPara) || 0;
            var baseOff = (playingOff != null) ? playingOff
                : ((delta > 0) ? Math.max(this._ttsCharOffset || 0, visOff)
                               : (this._ttsCharOffset || visOff));
            var cur = this._blockIndexOfOffset(baseOff);
            if (cur == null) cur = visPara;
            var hit = function (el) { return kind === 'paragraph' || /^H[1-6]$/.test(el.nodeName); };
            var pick = null;
            if (delta > 0) {
                for (var i = cur + 1; i < blocks.length; i++) if (hit(blocks[i])) { pick = i; break; }
            } else {
                for (var j = cur - 1; j >= 0; j--) if (hit(blocks[j])) { pick = j; break; }
            }
            if (pick == null) {                 // past the chapter edge → adjacent chapter
                if (this._chapterIndex + delta >= 0 && this._chapterIndex + delta < this._spine.length)
                    this._navigateChapter(delta);
                return;
            }
            // Highlight the target block — turns to its page in paged mode and
            // marks it even when it's already on the current page (so the move
            // is always visible). Also sets the Play-from point.
            var off = this._paraCharOffset(pick);
            this._ttsCharOffset = off;
            this._revealHighlight(frame, off, Math.min((blocks[pick].textContent || '').length, 240));
            this._updateProgressUI();
        },

        // Reveal + mark a target offset: highlight it (which turns to its page in
        // paged mode) and scroll it into view in the scrolling modes. The shared
        // "you moved here" feedback for every fine rotor unit.
        _revealHighlight: function (frame, offset, length) {
            this._ensureOffsetMap();
            // Skip leading whitespace: many blocks start with "\n   " indentation,
            // and a range over collapsed whitespace has a 0×0 rect, which makes
            // _highlightWord bail and draw nothing. Start on the first visible char.
            var txt = this._ttsFullText || '';
            var end = Math.min(offset + (length || 1), txt.length);
            while (offset < end && /\s/.test(txt.charAt(offset))) offset++;
            if (length) length = Math.max(1, end - offset);
            // Navigate to the target FIRST (turn to its page in paged mode via
            // offsetLeft geometry, or scroll to it otherwise) so the highlight
            // renders on-screen.
            var node = this._nodeAtOffset(this._ttsOffsetMap, offset);
            if (node) this._scrollNodeIntoView(frame, node);
            this._highlightWord(frame, offset, Math.max(1, length || 1));
        },

        _navByElementScroll: function (delta, kind, frame, doc) {
            var win = frame.contentWindow;
            var root = doc.getElementById('abr-scroll-root');
            if (!root) return;
            var sel = kind === 'heading'
                ? 'h1,h2,h3,h4,h5,h6'
                : 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figure,dt,dd';
            var els = Array.prototype.slice.call(root.querySelectorAll(sel));
            if (!els.length) return;
            var cur = -1;
            for (var i = 0; i < els.length; i++) {
                if (els[i].getBoundingClientRect().top <= 4) cur = i; else break;
            }
            var target = cur + delta;
            if (target < 0 || target >= els.length) { this._scrollMaybeLoadEdges(frame, doc); return; }
            win.scrollTo(0, els[target].getBoundingClientRect().top + win.pageYOffset - 16);
            this._updateProgressUI();
        },

        // Prev/Next sentence. Playing via Piper → seek the audio stream to the
        // target sentence's manifest time (instant, no re-synthesis). Otherwise
        // move the reading position to the sentence's character offset.
        // Prev/next sentence. Re-synthesizes from the target sentence's char
        // offset rather than seeking the audio: forward seeks on a progressive
        // Piper stream are ignored, which made skip "just keep reading from where
        // it was". Works for every voice. Playing → moves and keeps reading from
        // the new sentence; stopped → repositions + highlights, stays silent.
        _navBySentence: function (delta) {
            var frame = document.getElementById('abr-frame');
            if (!frame) return;
            var wasPlaying = this._ttsPlaying && !this._ttsPaused;
            var continuous = this._ttsContinuous;

            // Scroll mode scopes the map to the ACTIVE section, which changes as
            // you read, so it must be rebuilt each press. Page/chapter mode reads
            // a stable single-chapter body whose map is cleared on chapter change
            // (_ttsFullText = ''), so reuse the cached map instead of re-walking
            // the whole DOM on every sentence press.
            var built;
            if (this._viewMode === 'scroll') {
                built = this._buildOffsetMap(frame.contentDocument);
                this._ttsOffsetMap = built.map;
                this._ttsFullText = built.text;
            } else {
                this._ensureOffsetMap();
                built = { map: this._ttsOffsetMap, text: this._ttsFullText };
            }
            if (!built.text) return;

            // Current position. While playing: the live spoken offset. While
            // stopped: BLOCK GEOMETRY (_firstVisiblePara uses offsetLeft, which
            // is immune to the paged-mode CSS transform) — caretRangeFromPoint
            // mis-reads that transform in some browsers and sent every skip to a
            // consistent wrong spot. Consecutive skips keep advancing via
            // _ttsCharOffset; re-anchor when the visible top moves past it.
            var curOff;
            if (wasPlaying) {
                curOff = (this._piperLastAbs != null ? this._piperLastAbs
                          : (this._hlTickLast != null ? this._hlTickLast
                             : this._ttsCharOffset + this._ttsLastBoundary));
            } else {
                var geo = this._paraCharOffset(this._firstVisiblePara()) || 0;
                curOff = (this._ttsCharOffset > geo) ? this._ttsCharOffset : geo;
            }

            var starts = this._sentenceStarts(built.text);
            var ci = 0;
            for (var k = 0; k < starts.length; k++) { if (starts[k] <= curOff) ci = k; else break; }
            var rawTi = ci + delta;
            if (rawTi < 0 || rawTi >= starts.length) {   // past the chapter edge → adjacent chapter
                if (this._chapterIndex + delta >= 0 && this._chapterIndex + delta < this._spine.length) {
                    if (wasPlaying) this._ttsContinuous = true; // keep reading into the next chapter
                    this._navigateChapter(delta);
                }
                return;
            }
            var ti = rawTi;
            var target = starts[ti];

            // Tear current audio down cleanly, set the new start point
            this._stopHlTicker();
            this._stopPiperTts();
            this._stopTvTts();
            if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
            this._ttsUtterance = null;
            this._ttsLastBoundary = 0;
            this._ttsCharOffset = target;
            this._ttsPlaying = false;

            // Visible feedback: highlight the target sentence (turns to its page
            // in paged mode, scrolls to it in the scrolling modes).
            var senEnd = (ti + 1 < starts.length ? starts[ti + 1] : built.text.length);
            this._revealHighlight(frame, target, senEnd - target);

            if (wasPlaying) {                    // move-and-keep-reading
                this._ttsContinuous = continuous;
                this._updateTtsButtons(true);
                this._startTts();                // re-reads from the target sentence
            }
            this._updateProgressUI();
        },

        _sentenceStarts: function (text) {
            var starts = [0];
            var re = /[.!?]["'”’)\]]?\s+/g, m;
            while ((m = re.exec(text)) !== null) {
                var s = m.index + m[0].length;
                if (s < text.length) starts.push(s);
            }
            return starts;
        },

        _nodeAtOffset: function (map, off) {
            for (var i = 0; i < map.length; i++)
                if (off >= map[i].absStart && off < map[i].absEnd) return map[i].node;
            return map.length ? map[map.length - 1].node : null;
        },

        _scrollNodeIntoView: function (frame, node) {
            try {
                var el = node.nodeType === 3 ? node.parentElement : node;
                if (!el) return;
                if (this._viewMode === 'page') {
                    this._goToPage(Math.max(0, Math.min(this._pageCount - 1,
                        Math.round(el.offsetLeft / this._pageStep))), true);
                } else {
                    var win = frame.contentWindow;
                    win.scrollTo(0, el.getBoundingClientRect().top + win.pageYOffset - 16);
                }
            } catch (e) {}
        },

        _setupChapterView: function (frame) {
            var self = this;
            var doc;
            try { doc = frame.contentDocument; } catch (e) { return; }
            if (!doc || !doc.body) return;

            // Base reading style + pagination rules live in one injected sheet
            var style = doc.getElementById('abr-view-style');
            if (!style) {
                style = doc.createElement('style');
                style.id = 'abr-view-style';
                doc.head.appendChild(style);
            }
            self._applyViewMode(frame, doc, style);

            // Tap zones: thirds — back / reveal-controls / forward (paged mode)
            if (!doc.body.abrTapWired) {
                doc.body.abrTapWired = true;
                doc.addEventListener('click', function (e) {
                    // Internal links route through the reader — never let the
                    // iframe navigate away. Footnote refs open as popovers.
                    var a = e.target.closest('a');
                    if (a) {
                        // epub:type is namespaced; HTML parsing exposes it via
                        // attributes() not getAttribute('epub:type'). Check both
                        // the literal name and the role mapping.
                        var etype = a.getAttribute('epub:type') ||
                            a.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ||
                            a.getAttribute('data-epub-type') || '';
                        var role = a.getAttribute('role') || '';
                        var isNoteref = /noteref/.test(etype) ||
                            role === 'doc-noteref' || role === 'doc-backlink';
                        if (a.dataset.abrChapter !== undefined) {
                            e.preventDefault();
                            var ch = parseInt(a.dataset.abrChapter, 10);
                            var an = a.dataset.abrAnchor || null;
                            if (isNoteref && an) self._showFootnote(ch, an, a.textContent);
                            else self._goToTarget(ch, an, true);
                            return;
                        }
                        var href = a.getAttribute('href') || '';
                        if (href.startsWith('#')) {
                            e.preventDefault();
                            var id = href.slice(1);
                            if (!id) return;
                            if (isNoteref) { self._showFootnote(self._chapterIndex, id, a.textContent); return; }
                            self._navStack.push(self._snapshotLocator());
                            self._updateBackBtn();
                            self._goToAnchor(id);
                            return;
                        }
                        return; // external link: leave default behavior
                    }
                    if (e.target.closest('button, input, select, textarea')) return;
                    var sel = doc.getSelection && doc.getSelection();
                    if (sel && sel.toString()) return;
                    var x = e.clientX / doc.documentElement.clientWidth;
                    // Middle-third tap toggles controls in BOTH modes (QA defect #3);
                    // side tap zones page-turn only in paged mode
                    if (x >= 0.33 && x <= 0.66) { self._setImmersive(!self._immersive); return; }
                    if (self._viewMode !== 'page') return;
                    self._turnByPage(x < 0.33 ? -1 : 1);
                });
                // Swipe inside the content
                var sx = 0;
                doc.addEventListener('touchstart', function (e) {
                    sx = e.touches[0].clientX;
                }, { passive: true });
                doc.addEventListener('touchend', function (e) {
                    var dx = e.changedTouches[0].clientX - sx;
                    if (Math.abs(dx) > 50) self._turnByPage(dx < 0 ? 1 : -1);
                });
                // Ruler tracks the pointer's reading line
                doc.addEventListener('mousemove', function (e) {
                    if (!self._rulerOn) return;
                    var ruler = document.getElementById('abr-ruler');
                    var frameRect = frame.getBoundingClientRect();
                    if (ruler) ruler.style.top = (frameRect.top + e.clientY - 24) + 'px';
                });
            }

            // Recompute pagination when the viewport changes
            if (!self._resizeWired) {
                self._resizeWired = true;
                window.addEventListener('resize', function () {
                    if (self._resizeTimer) clearTimeout(self._resizeTimer);
                    self._resizeTimer = setTimeout(function () {
                        var f = document.getElementById('abr-frame');
                        if (f) self._setupChapterView(f);
                    }, 200);
                });
            }

            // Cover art SVGs ship preserveAspectRatio="none" sized for a fixed
            // page; in a reflowed box that STRETCHES the art. "meet" letterboxes
            // it instead, keeping the aspect ratio in any box. (Not expressible
            // in CSS — preserveAspectRatio is an attribute, so rewrite it here.)
            self._fixSvgAspect(doc);

            // Highlights & notes: selection popover + persistent highlight paint
            self._wireSelection(frame, doc);
            self._paintAnnotations(frame);

            // Page view shows a clipped horizontal strip — the browser still
            // auto-scrolls the clipped root on focus jumps, selection drags,
            // and find-in-page. Any horizontal offset breaks the column grid
            // (half a page each side), so snap it back: the body transform is
            // the only legitimate horizontal motion.
            if (!doc.abrAlignWired) {
                doc.abrAlignWired = true;
                doc.addEventListener('scroll', function () {
                    if (self._viewMode !== 'page') return;
                    var de = doc.documentElement;
                    if (de.scrollLeft) de.scrollLeft = 0;
                }, true);
            }
        },

        _applyViewMode: function (frame, doc, style) {
            var self = this;
            var w = frame.clientWidth;
            var keepFraction = self._pageCount > 1 ? self._page / (self._pageCount - 1) : 0;
            var ds = self._ds || self._dsDefaults;
            // Margin setting drives the page gutters in both modes
            var marginPx = Math.round(w * ds.MarginPct / 100);
            var reading = self._readingCss();

            if (self._viewMode === 'page') {
                style.textContent = reading +
                    'html{height:100%;overflow:hidden;}' +
                    // NOTE: no overflow:hidden on body — an element's overflow
                    // clip moves WITH its own transform, so a clipped body
                    // slides its window off-screen on page turns (blank page).
                    // The static html element does the clipping instead.
                    // !important throughout: EPUB body classes (e.g. Calibre's
                    // .calibre with its own margins) outrank a bare 'body'
                    // selector — losing the gutters changes the real column
                    // advance away from pageStep and every page splits in half
                    'body{height:100% !important;margin:0 !important;padding:24px ' + marginPx + 'px !important;box-sizing:border-box !important;' +
                    'column-width:' + (w - marginPx * 2) + 'px !important;column-gap:' + (marginPx * 2) + 'px !important;column-fill:auto !important;}' +
                    // Fit images to the view while keeping aspect ratio: width/height
                    // auto override publisher dimension attributes that would distort
                    'img,video{max-width:100%;max-height:85vh;width:auto;height:auto;object-fit:contain;}' +
                'svg{max-width:100%;max-height:85vh;}' + // size caps only: width/height auto would override an SVG cover's 100% attributes and collapse it to blank
                    // Column integrity: publisher CSS (Calibre wrappers etc.) can set
                    // widths wider than the column box; CSS columns don't clamp them,
                    // so the content bleeds across the gap into the NEXT page view
                    // (half page left, half of the next right). Clamp block widths and
                    // wrap long words (wide letter/word spacing amplifies them).
                    'body div,body p,body table,body pre,body blockquote{max-width:100% !important;box-sizing:border-box;}' +
                    'body{overflow-wrap:break-word;}' +
                    (self._reducedMotion ? '' :
                        'body{transition:transform 0.18s ease-out;}');
                self._pageStep = w;
                // Leaving scroll mode: the html element keeps its scroll offset
                // even under overflow:hidden, leaving the viewport past the
                // now-one-screen-tall column box → blank page. Reset it.
                try {
                    doc.documentElement.scrollTop = 0;
                    doc.documentElement.scrollLeft = 0;
                    if (doc.body.scrollTop) doc.body.scrollTop = 0;
                } catch (e) {}
                // Force layout, then measure total horizontal flow
                var total = doc.body.scrollWidth;
                self._pageCount = Math.max(1, Math.round(total / w));
                // Forced breaks (Calibre page-break divs at chapter ends) leave a
                // trailing EMPTY column that scrollWidth counts as a page — every
                // chapter then ends on a blank view, and entering from the end or
                // resuming near 100% lands straight on it. Trust the last CONTENT
                // edge instead and drop trailing empties.
                try {
                    var lastRight = 0;
                    var els = doc.body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figure,dt,dd,img,svg,table,video');
                    for (var ei = 0; ei < els.length; ei++) {
                        var el2 = els[ei];
                        if (!(el2.offsetWidth > 0)) continue;
                        var tn = (el2.tagName || '').toUpperCase();
                        var isMedia = tn === 'IMG' || tn === 'SVG' || tn === 'TABLE' || tn === 'VIDEO';
                        if (!isMedia && !(el2.textContent || '').trim()) continue;
                        var edge = el2.offsetLeft + el2.offsetWidth;
                        if (edge > lastRight) lastRight = edge;
                    }
                    if (lastRight > 0) {
                        self._pageCount = Math.max(1, Math.min(self._pageCount, Math.ceil(lastRight / w)));
                    }
                } catch (e) {}
                var entry = self._enterAtEnd ? self._pageCount - 1
                    : Math.round(keepFraction * (self._pageCount - 1));
                self._enterAtEnd = false;
                self._goToPage(Math.min(entry, self._pageCount - 1), true);
            } else {
                style.textContent = reading +
                    'html{overflow-y:auto;}' +
                    'body{margin:0 !important;padding:24px ' + marginPx + 'px !important;box-sizing:border-box !important;column-width:auto !important;transform:none;overflow-wrap:break-word;}' +
                    'img,video{max-width:100%;max-height:85vh;width:auto;height:auto;object-fit:contain;}' +
                'svg{max-width:100%;max-height:85vh;}' + // size caps only: width/height auto would override an SVG cover's 100% attributes and collapse it to blank
                    'body div,body p,body table,body pre,body blockquote{max-width:100% !important;box-sizing:border-box;}';
                doc.body.style.transform = '';
                self._page = 0;
                self._pageCount = 1;
                self._updateProgressUI();
            }
        },

        _goToPage: function (page, instant) {
            var frame = document.getElementById('abr-frame');
            var doc; try { doc = frame.contentDocument; } catch (e) { return; }
            if (!doc || !doc.body) return;
            this._page = Math.max(0, Math.min(page, this._pageCount - 1));
            // Pin the html element: anything that programmatically scrolled it
            // (smooth scrolls, focus jumps) would skew the page alignment
            try { doc.documentElement.scrollLeft = 0; doc.documentElement.scrollTop = 0; } catch (e) {}
            if (instant || this._reducedMotion) doc.body.style.transitionDuration = '0s';
            else doc.body.style.transitionDuration = '';
            doc.body.style.transform = 'translateX(' + (-this._page * this._pageStep) + 'px)';
            this._updateProgressUI();
            this._saveProgress(this._chapterIndex,
                this._pageCount > 1 ? this._page / (this._pageCount - 1) : 0,
                this._firstVisiblePara());
        },

        // Ribbon fill + page readout + rich announce label
        // knownFraction: pass an already-computed scroll fraction to skip the
        // _currentScrollFraction() recompute (which re-runs _scrollActiveInfo).
        // The per-frame scroll tick passes it; other callers omit it.
        _updateProgressUI: function (knownFraction) {
            var spineLen = Math.max(1, this._spine.length);
            var within = this._viewMode === 'page'
                ? (this._pageCount > 1 ? this._page / (this._pageCount - 1) : 1)
                : (knownFraction != null ? knownFraction : this._currentScrollFraction());
            var bookPct = Math.round(((this._chapterIndex + within) / spineLen) * 100);

            var fill = document.getElementById('abr-ribbon-fill');
            if (fill) fill.style.height = bookPct + '%';

            var pageInfo = document.getElementById('abr-page-info');
            var ribbon = document.getElementById('abr-ribbon');
            var text, announce;
            if (this._viewMode === 'page') {
                var left = this._pageCount - 1 - this._page;
                text = 'Page ' + (this._page + 1) + ' of ' + this._pageCount + ' · ' + bookPct + '%';
                announce = 'Page ' + (this._page + 1) + ' of ' + this._pageCount +
                    ' in chapter, ' + left + (left === 1 ? ' page' : ' pages') +
                    ' left, ' + bookPct + '% of book';
            } else {
                text = bookPct + '% of book';
                announce = Math.round(within * 100) + '% through chapter, ' + bookPct + '% of book';
            }
            if (pageInfo) pageInfo.textContent = text;
            if (ribbon) {
                ribbon.setAttribute('aria-valuenow', String(bookPct));
                ribbon.setAttribute('aria-valuetext', announce);
            }
        },

        // Cycle Page → Chapter → Scroll → Page. Page/Chapter relayout the
        // current chapter frame in place; Scroll enters/leaves the full-book
        // virtualized stitcher (see the Scroll engine section).
        // Switch to a specific view mode, preserving the reading position.
        // Shared by the (optional) toolbar cycle button and the Page-tab choice.
        _setViewMode: function (next) {
            var prev = this._viewMode;
            if (!next || next === prev) return;
            // Capture the reading position under the OUTGOING mode so the switch
            // lands in the same place, not at the top (QA defect #1).
            var keepChapter = this._chapterIndex;
            var keepPara = this._firstVisiblePara();
            var keep = this._currentScrollFraction();

            this._viewMode = next;
            if (this._ds) { this._ds.ViewMode = next; this._saveDisplaySettings(); }
            this._announceViewMode(next);
            this._syncViewModeChoice();     // keep the Page-tab radios in sync
            this._updateNavStepLabels();    // Prev/Next announce page vs chapter

            if (next === 'scroll') {
                this._enterScrollMode(keepChapter, keepPara, keep);
            } else if (prev === 'scroll') {
                this._exitScrollMode(keepChapter, keepPara, keep);
            } else {
                this._relayoutChapter(keepPara, keep);
            }

            var pageInfo = document.getElementById('abr-page-info');
            if (pageInfo) pageInfo.setAttribute('aria-live', next === 'page' ? 'polite' : 'off');
        },

        _syncViewModeChoice: function () {
            var grp = document.getElementById('abr-viewmode-choice');
            if (!grp) return;
            var self = this;
            grp.querySelectorAll('[role="radio"]').forEach(function (r) {
                var on = r.dataset.value === self._viewMode;
                r.setAttribute('aria-checked', on ? 'true' : 'false');
                r.tabIndex = on ? 0 : -1; // keep the roving Tab stop on the selection
            });
        },

        _announceViewMode: function (mode) {
            var m = this._modeMeta[mode] || this._modeMeta.chapter;
            var info = document.getElementById('abr-chapter-info'); // polite live region
            if (info) info.textContent = 'View mode: ' + m.label;
        },

        // Relayout the current single chapter in place (page ↔ chapter switch),
        // restoring the captured reading position.
        _relayoutChapter: function (keepPara, keep) {
            var frame = document.getElementById('abr-frame');
            if (!frame) return;
            this._setupChapterView(frame);
            this._pendingScrollFraction = null;
            if (!this._goToPara(keepPara) && keep !== null) {
                if (this._viewMode === 'page') {
                    this._goToPage(Math.round(keep * (this._pageCount - 1)), true);
                } else {
                    try {
                        var win = frame.contentWindow, doc = win.document.documentElement;
                        var max = doc.scrollHeight - doc.clientHeight;
                        if (max > 0) win.scrollTo(0, keep * max);
                    } catch (e) {}
                    this._updateProgressUI();
                }
            }
        },

        // ── Scroll engine: full-book continuous reading (virtualized) ────────
        // One host document inside #abr-frame holds a moving window of chapters
        // as <section class="abr-ch" data-ch="i"> blocks. Chapters load lazily
        // as the reader nears an edge and far ones drop, so memory stays bounded
        // on any book size. Positions stay per-chapter (Readium locator) by
        // reading the active section's data-ch + the block index within it.

        _scrollWindow: 1,    // chapters kept loaded on each side of the active one
        _scrollBusy: false,  // guards against overlapping lazy loads
        _scrollSections: null,

        // Fetch one chapter's server-rendered HTML (full document, URLs already
        // absolute) and return its body content + hoistable head styles.
        _fetchChapterParts: function (index) {
            var self = this;
            var url = ApiClient.getUrl('A11yBookReader/chapter/' + self._currentItemId + '/' + index);
            return ApiClient.ajax({ url: url, type: 'GET', dataType: 'text' }).then(function (htmlText) {
                var parsed = new DOMParser().parseFromString(htmlText, 'text/html');
                var heads = [];
                // Hoist linked + inline stylesheets so chapter styling survives
                // the move into the shared host document (deduped by key).
                parsed.querySelectorAll('head link[rel~="stylesheet"], head style').forEach(function (n) {
                    heads.push(n.tagName === 'LINK'
                        ? { type: 'link', key: n.getAttribute('href') || '', href: n.getAttribute('href') }
                        : { type: 'style', key: n.textContent, css: n.textContent });
                });
                return { body: parsed.body ? parsed.body.innerHTML : '', heads: heads };
            });
        },

        // Inject (or replace) the section for chapter `index` at the right
        // ordinal position so sections stay in spine order. Returns the element.
        _stitchSection: function (doc, index, parts) {
            var root = doc.getElementById('abr-scroll-root');
            if (!root || this._scrollSections[index]) return this._scrollSections[index];
            var sec = doc.createElement('section');
            sec.className = 'abr-ch';
            sec.setAttribute('data-ch', String(index));
            var ch = this._spine[index];
            sec.setAttribute('aria-label', 'Chapter ' + (index + 1) +
                (ch && ch.title ? ': ' + ch.title : ''));
            sec.innerHTML = parts.body;

            // Hoist this chapter's head styles into the host head, once each
            var hostHead = doc.getElementById('abr-host-style');
            for (var i = 0; i < parts.heads.length; i++) {
                var h = parts.heads[i];
                if (this._scrollHeads[h.key]) continue;
                this._scrollHeads[h.key] = true;
                if (h.type === 'link') {
                    var lnk = doc.createElement('link');
                    lnk.rel = 'stylesheet'; lnk.href = h.href;
                    doc.head.insertBefore(lnk, hostHead);
                } else {
                    var st = doc.createElement('style');
                    st.textContent = h.css;
                    doc.head.insertBefore(st, hostHead);
                }
            }

            // Insert in spine order relative to already-loaded sections
            var after = null, before = null, k;
            for (k = index - 1; k >= 0; k--) { if (this._scrollSections[k]) { after = this._scrollSections[k]; break; } }
            if (!after) for (k = index + 1; k < this._spine.length; k++) { if (this._scrollSections[k]) { before = this._scrollSections[k]; break; } }
            if (after) root.insertBefore(sec, after.nextSibling);
            else if (before) root.insertBefore(sec, before);
            else root.appendChild(sec);

            this._scrollSections[index] = sec;
            this._wireSectionInteractions(doc, sec, index);
            this._fixSvgAspect(sec);
            // New section resident: paint any of its highlights/notes, and make
            // sure selection handlers exist on the stitched host document
            var fr = document.getElementById('abr-frame');
            if (fr) { this._wireSelection(fr, doc); this._paintAnnotations(fr); }
            return sec;
        },

        _enterScrollMode: function (chapterIndex, keepPara, keepFraction) {
            var self = this;
            var frame = document.getElementById('abr-frame');
            if (!frame) return;
            // Tear down per-chapter TTS/highlight bound to the outgoing doc
            self._navResetTts();
            self._scrollHeads = {};
            self._scrollSections = {};

            // Build a fresh host document in the same iframe
            frame.removeAttribute('src');
            var doc = frame.contentDocument;
            doc.open();
            doc.write('<!DOCTYPE html><html><head><meta charset="utf-8">' +
                '<style id="abr-view-style"></style><style id="abr-host-style"></style>' +
                '</head><body><div id="abr-scroll-root"></div></body></html>');
            doc.close();
            self._applyScrollHostStyle(frame, doc);

            self._chapterIndex = chapterIndex;
            // Active chapter first so the reader can land immediately…
            self._fetchChapterParts(chapterIndex).then(function (parts) {
                self._stitchSection(doc, chapterIndex, parts);
                // Land on the captured position within the active section
                if (!self._scrollGoToPara(chapterIndex, keepPara) && keepFraction != null) {
                    self._scrollToSectionFraction(chapterIndex, keepFraction);
                }
                self._wireScrollHandlers(frame, doc);
                self._updateProgressUI();
                // …then pull in the neighbors to fill the window
                self._scrollEnsureWindow();
            }).catch(function () {});
        },

        _exitScrollMode: function (chapterIndex, keepPara, keepFraction) {
            // Detach scroll handlers, then reload the captured chapter as a
            // normal single-chapter document for page/chapter mode.
            var frame = document.getElementById('abr-frame');
            if (frame && this._scrollHandler) {
                try { frame.contentWindow.removeEventListener('scroll', this._scrollHandler); } catch (e) {}
            }
            this._scrollHandler = null;
            this._scrollSections = null;
            this._scrollHeads = null;
            // _loadChapter resets the frame to /chapter/{id}/{index}; carry the
            // paragraph anchor so we land where we were.
            this._pendingPara = keepPara;
            this._loadChapter(chapterIndex);
        },

        _applyScrollHostStyle: function (frame, doc) {
            var ds = this._ds || this._dsDefaults;
            var marginPx = Math.round(frame.clientWidth * ds.MarginPct / 100);
            var style = doc.getElementById('abr-view-style');
            if (style) style.textContent = this._readingCss() +
                'html{overflow-y:auto;}' +
                'body{margin:0 !important;padding:24px ' + marginPx + 'px !important;box-sizing:border-box !important;column-width:auto !important;transform:none;overflow-wrap:break-word;}' +
                '.abr-ch + .abr-ch{margin-top:2.5em;padding-top:2.5em;border-top:2px solid currentColor;}' +
                'img,video{max-width:100%;max-height:85vh;width:auto;height:auto;object-fit:contain;}' +
                'svg{max-width:100%;max-height:85vh;}' + // size caps only: width/height auto would override an SVG cover's 100% attributes and collapse it to blank
                'body div,body p,body table,body pre,body blockquote{max-width:100% !important;box-sizing:border-box;}';
            if (this._applyChromeTheme) this._applyChromeTheme();
        },

        _getBlocksIn: function (el) {
            return el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, dt, dd');
        },

        // Stretched cover art: preserveAspectRatio="none" was authored for a
        // fixed page and distorts in any other box — "meet" letterboxes instead.
        _fixSvgAspect: function (root) {
            try {
                root.querySelectorAll('svg[preserveAspectRatio="none"]').forEach(function (s) {
                    s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                });
            } catch (e) {}
        },

        // The active chapter is the first section still substantially in view at
        // the top; the para is the block index WITHIN that section (so positions
        // stay per-chapter for the Readium locator).
        _scrollActiveInfo: function (doc) {
            if (!this._scrollSections) return null;
            var sections = doc.querySelectorAll('section.abr-ch');
            if (!sections.length) return null;
            var vh = doc.documentElement.clientHeight;
            var active = null;
            for (var i = 0; i < sections.length; i++) {
                var r = sections[i].getBoundingClientRect();
                if (r.bottom > vh * 0.2) { active = sections[i]; break; }
            }
            if (!active) active = sections[sections.length - 1];
            var chapter = parseInt(active.getAttribute('data-ch'), 10);
            var blocks = this._getBlocksIn(active);
            var para = 0;
            for (var b = 0; b < blocks.length; b++) {
                var br = blocks[b].getBoundingClientRect();
                if (br.bottom > 0 && br.top < vh) { para = b; break; }
            }
            return { chapter: chapter, para: para, section: active };
        },

        _sectionFraction: function (section) {
            var win = document.getElementById('abr-frame').contentWindow;
            var top = section.getBoundingClientRect().top + win.pageYOffset;
            var into = win.pageYOffset - top;
            return Math.max(0, Math.min(1, into / (section.offsetHeight || 1)));
        },

        _scrollGoToPara: function (chapterIndex, para) {
            var sec = this._scrollSections && this._scrollSections[chapterIndex];
            if (!sec || para == null) return false;
            var blocks = this._getBlocksIn(sec);
            if (para < 0 || para >= blocks.length) return false;
            var win = document.getElementById('abr-frame').contentWindow;
            win.scrollTo(0, blocks[para].getBoundingClientRect().top + win.pageYOffset - 16);
            return true;
        },

        _scrollToSectionFraction: function (chapterIndex, frac) {
            var sec = this._scrollSections && this._scrollSections[chapterIndex];
            if (!sec) return;
            var win = document.getElementById('abr-frame').contentWindow;
            var top = sec.getBoundingClientRect().top + win.pageYOffset;
            win.scrollTo(0, top + frac * sec.offsetHeight - 16);
        },

        // Jump to an element id in scroll mode, loading its chapter section
        // first if it isn't resident yet. id === null scrolls to section top.
        _scrollGoToAnchor: function (chapterIndex, id) {
            var self = this;
            var doc = document.getElementById('abr-frame').contentDocument;
            var go = function () {
                var sec = self._scrollSections[chapterIndex];
                if (!sec) return false;
                var el = id ? sec.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id)) : sec;
                if (!el) return false;
                var win = doc.defaultView;
                var target = el.getBoundingClientRect().top + win.pageYOffset - 16;
                win.scrollTo(0, target);
                // A target past the end of the loaded content gets CLAMPED to
                // max-scroll: the viewport then sits inside the PREVIOUS section
                // and the position tracker snaps the chapter index back. Count a
                // clamped scroll as not-arrived (and queue the next section so
                // the document grows) — the retry loop below re-scrolls once the
                // target is reachable. On the book's final section the target may
                // stay unreachable; retries exhaust and the clamped position (the
                // best possible) stands.
                if (win.scrollY < target - 2) {
                    if (self._spine && chapterIndex + 1 < self._spine.length) self._scrollQueueLoad(doc, chapterIndex + 1);
                    return false;
                }
                return true;
            };
            if (go()) return;
            this._scrollQueueLoad(doc, chapterIndex);
            var tries = 0;
            var iv = setInterval(function () { if (go() || ++tries > 20) clearInterval(iv); }, 100);
        },

        _wireScrollHandlers: function (frame, doc) {
            var self = this;
            var win = frame.contentWindow;
            if (self._scrollHandler) { try { win.removeEventListener('scroll', self._scrollHandler); } catch (e) {} }
            self._scrollHandler = function () {
                if (self._scrollRaf) return;
                self._scrollRaf = win.requestAnimationFrame(function () {
                    self._scrollRaf = 0;
                    self._onScrollTick(frame, doc);
                });
            };
            win.addEventListener('scroll', self._scrollHandler, { passive: true });
        },

        _onScrollTick: function (frame, doc) {
            var info = this._scrollActiveInfo(doc);
            // Compute the section fraction once and reuse it for both the saved
            // progress and the progress UI — _updateProgressUI would otherwise
            // re-derive it via _currentScrollFraction → a second _scrollActiveInfo
            // (the redundant layout pass that caused scroll jank).
            var frac = null;
            if (info) {
                this._chapterIndex = info.chapter;
                frac = this._sectionFraction(info.section);
                this._saveProgress(info.chapter, frac, info.para);
            }
            this._updateProgressUI(frac);
            this._scrollMaybeLoadEdges(frame, doc);
        },

        _scrollMaybeLoadEdges: function (frame, doc) {
            var win = frame.contentWindow, de = doc.documentElement;
            var loaded = Object.keys(this._scrollSections).map(Number).sort(function (a, b) { return a - b; });
            if (!loaded.length) return;
            var lo = loaded[0], hi = loaded[loaded.length - 1];
            if (win.pageYOffset + de.clientHeight > de.scrollHeight - de.clientHeight && hi < this._spine.length - 1)
                this._scrollQueueLoad(doc, hi + 1);
            if (win.pageYOffset < de.clientHeight && lo > 0)
                this._scrollQueueLoad(doc, lo - 1);
            this._scrollTrimWindow(doc);
        },

        // Serialized loader: one fetch at a time. Prepended sections (above the
        // viewport) compensate scrollTop so the page doesn't jump.
        _scrollQueueLoad: function (doc, index) {
            if (!this._scrollSections || this._scrollSections[index]) return;
            this._scrollQ = this._scrollQ || [];
            if (this._scrollQ.indexOf(index) === -1) this._scrollQ.push(index);
            this._scrollPump(doc);
        },

        _scrollPump: function (doc) {
            var self = this;
            if (self._scrollBusy || !self._scrollQ || !self._scrollQ.length) return;
            var index = self._scrollQ.shift();
            if (!self._scrollSections || self._scrollSections[index]) { self._scrollPump(doc); return; }
            self._scrollBusy = true;
            var win = document.getElementById('abr-frame').contentWindow;
            var beforeH = doc.documentElement.scrollHeight, beforeY = win.pageYOffset;
            var prepend = index < self._chapterIndex;
            self._fetchChapterParts(index).then(function (parts) {
                if (!self._scrollSections) return; // exited scroll mode mid-flight
                self._stitchSection(doc, index, parts);
                if (prepend) win.scrollTo(0, beforeY + (doc.documentElement.scrollHeight - beforeH));
            }).catch(function () {}).then(function () {
                self._scrollBusy = false;
                self._scrollPump(doc);
            });
        },

        _scrollTrimWindow: function (doc) {
            var keep = this._scrollWindow + 1;
            var win = document.getElementById('abr-frame').contentWindow;
            var self = this;
            Object.keys(this._scrollSections).map(Number).forEach(function (idx) {
                if (Math.abs(idx - self._chapterIndex) <= keep) return;
                var sec = self._scrollSections[idx];
                if (idx < self._chapterIndex) {
                    var beforeH = doc.documentElement.scrollHeight, beforeY = win.pageYOffset;
                    sec.parentNode.removeChild(sec);
                    win.scrollTo(0, Math.max(0, beforeY - (beforeH - doc.documentElement.scrollHeight)));
                } else {
                    sec.parentNode.removeChild(sec);
                }
                delete self._scrollSections[idx];
            });
        },

        _scrollEnsureWindow: function () {
            var frame = document.getElementById('abr-frame');
            if (!frame || !this._scrollSections) return;
            var doc = frame.contentDocument, c = this._chapterIndex;
            for (var d = 1; d <= this._scrollWindow; d++) {
                if (c - d >= 0) this._scrollQueueLoad(doc, c - d);
                if (c + d < this._spine.length) this._scrollQueueLoad(doc, c + d);
            }
        },

        // Doc-level interactions for the stitched host (wired once): internal
        // links resolve within their own section's chapter; middle-tap toggles
        // controls. No side-tap page turns in continuous scroll.
        _wireSectionInteractions: function (doc, sec, index) {
            var self = this;
            if (doc.body.abrScrollWired) return;
            doc.body.abrScrollWired = true;
            doc.addEventListener('click', function (e) {
                var a = e.target.closest('a');
                if (a) {
                    var owner = a.closest('section.abr-ch');
                    var chIdx = owner ? parseInt(owner.getAttribute('data-ch'), 10) : self._chapterIndex;
                    var etype = a.getAttribute('epub:type') ||
                        a.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ||
                        a.getAttribute('data-epub-type') || '';
                    var role = a.getAttribute('role') || '';
                    var isNoteref = /noteref/.test(etype) || role === 'doc-noteref' || role === 'doc-backlink';
                    if (a.dataset.abrChapter !== undefined) {
                        e.preventDefault();
                        var ch = parseInt(a.dataset.abrChapter, 10);
                        var an = a.dataset.abrAnchor || null;
                        if (isNoteref && an) self._showFootnote(ch, an, a.textContent);
                        else self._scrollGoToAnchor(ch, an);
                        return;
                    }
                    var href = a.getAttribute('href') || '';
                    if (href.startsWith('#')) {
                        e.preventDefault();
                        var id = href.slice(1);
                        if (!id) return;
                        if (isNoteref) { self._showFootnote(chIdx, id, a.textContent); return; }
                        self._scrollGoToAnchor(chIdx, id);
                    }
                    return;
                }
                if (e.target.closest('button, input, select, textarea')) return;
                var seln = doc.getSelection && doc.getSelection();
                if (seln && seln.toString()) return;
                var x = e.clientX / doc.documentElement.clientWidth;
                if (x >= 0.33 && x <= 0.66) self._setImmersive(!self._immersive);
            });
        },

        _setImmersive: function (on) {
            // Close open panels properly first so their buttons' aria-expanded
            // stays truthful while hidden by immersive mode
            if (on) {
                var settingsModal = document.getElementById('abr-settings');
                if (settingsModal && !settingsModal.hasAttribute('hidden')) this._closeSettingsModal();
                var bookmap = document.getElementById('abr-bookmap');
                if (bookmap && !bookmap.hasAttribute('hidden')) this._toggleBookMap();
            }
            this._immersive = !!on;
            var overlay = document.getElementById('abr-overlay');
            if (overlay) overlay.classList.toggle('abr-immersive', this._immersive);
            var showCtrls = document.getElementById('abr-show-controls');
            if (showCtrls) {
                if (this._immersive) showCtrls.removeAttribute('hidden');
                else showCtrls.setAttribute('hidden', '');
            }
            var immersiveBtn = document.getElementById('abr-immersive-toggle');
            var info = document.getElementById('abr-chapter-info');
            if (info) info.textContent = this._immersive
                ? 'Controls hidden. Press Escape or the show controls button to bring them back.'
                : 'Controls shown';
            if (this._immersive && showCtrls) showCtrls.focus();
            else if (!this._immersive && immersiveBtn) immersiveBtn.focus();
        },

        // ── Keyboard & Focus ─────────────────────────────────────────────────

        _onKeyDown: function (e) {
            var overlay = document.getElementById('abr-overlay');
            if (!overlay) return;

            // Escape / TV back, in priority order: dismiss a footnote →
            // close the settings modal → close the book map → leave immersive →
            // close the reader
            if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
                e.preventDefault();
                var selPop = document.getElementById('abr-sel-pop');
                if (selPop) { this._hideSelPopover(); return; }
                var footnote = document.getElementById('abr-footnote');
                if (footnote) {
                    footnote.remove();
                    var fr = document.getElementById('abr-frame');
                    if (fr) fr.focus();
                    return;
                }
                var settingsModal = document.getElementById('abr-settings');
                if (settingsModal && !settingsModal.hasAttribute('hidden')) { this._closeSettingsModal(); return; }
                var bookmap = document.getElementById('abr-bookmap');
                if (bookmap && !bookmap.hasAttribute('hidden')) { this._toggleBookMap(); return; }
                if (this._immersive) { this._setImmersive(false); return; }
                this._closeReader(); return;
            }
            // p = play/pause TTS
            // Text inputs own all their own keys (cursor, letters incl. "p").
            // Must precede the p=play and arrow handlers below.
            var ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
                       ae.isContentEditable)) {
                return;
            }

            if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this._toggleTts(); return; }
            // b = toggle a bookmark at the current position
            if (e.key === 'b' || e.key === 'B') { e.preventDefault(); this._toggleBookmark(); return; }
            // h / n act on a pending text selection (set by the iframe handlers)
            if ((e.key === 'h' || e.key === 'H') && this._pendingSel) { e.preventDefault(); this._createAnnotation('highlight', null); return; }
            if ((e.key === 'n' || e.key === 'N') && this._pendingSel) { e.preventDefault(); this._openNoteEditor(); return; }

            // Reading keys while the book frame has focus: act on the content
            var frame = document.getElementById('abr-frame');
            if (document.activeElement === frame) {
                if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault(); this._turnByPage(1); return;
                }
                if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                    e.preventDefault(); this._turnByPage(-1); return;
                }
                if (this._viewMode === 'scroll' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault();
                    try {
                        frame.contentWindow.scrollBy({
                            top: e.key === 'ArrowDown' ? 60 : -60,
                            behavior: this._reducedMotion ? 'auto' : 'smooth'
                        });
                    } catch (err) {}
                    return;
                }
                if (this._viewMode === 'page' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault(); this._turnByPage(e.key === 'ArrowDown' ? 1 : -1); return;
                }
                if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    if (this._viewMode === 'page') {
                        this._goToPage(e.key === 'Home' ? 0 : this._pageCount - 1);
                    } else {
                        try {
                            var w = frame.contentWindow;
                            w.scrollTo(0, e.key === 'Home' ? 0 : w.document.documentElement.scrollHeight);
                        } catch (err) {}
                    }
                    return;
                }
            }

            // Arrow keys: lock focus inside the overlay and move between controls.
            // Exception: selects handle all their own arrows (dropdown navigation).
            // Range inputs: left/right adjust value (browser handles); up/down escape to adjacent control.
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
                e.key === 'ArrowUp'   || e.key === 'ArrowDown') {
                var active = document.activeElement;
                e.preventDefault();
                var focusable = Array.from(
                    overlay.querySelectorAll('button:not([disabled]), input, select')
                ).filter(function (el) {
                    return !el.hasAttribute('hidden') && !el.closest('[hidden]');
                });
                if (!focusable.length) return;
                var idx = focusable.indexOf(document.activeElement);
                var isBack = (e.key === 'ArrowLeft' || e.key === 'ArrowUp');
                var next;
                if (isBack) {
                    next = idx > 0 ? focusable[idx - 1] : focusable[focusable.length - 1];
                } else {
                    next = idx < focusable.length - 1 ? focusable[idx + 1] : focusable[0];
                }
                if (next) next.focus();
            }
        },

        _trapFocus: function (overlay) {
            overlay.addEventListener('keydown', function (e) {
                if (e.key !== 'Tab') return;
                // With an aria-modal dialog open (settings / book map), the trap
                // must cycle INSIDE the dialog — trapping at the overlay level let
                // Tab walk the toolbar behind it (WCAG C1). No dialog → overlay.
                var root = overlay.querySelector('.abr-modal:not([hidden])') || overlay;
                var focusable = Array.from(
                    root.querySelectorAll('button:not([disabled]), iframe[tabindex="0"], [tabindex="0"]')
                ).filter(function (el) {
                    // Exclude hidden subtrees and roving-tabindex parked elements
                    // (tabIndex -1 isn't in the real Tab order).
                    return !el.closest('[hidden]') && el.tabIndex >= 0;
                });
                if (!focusable.length) return;

                var first = focusable[0];
                var last = focusable[focusable.length - 1];

                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            });
        },

        // Stamp show-focus on every interactive element so TV focus ring always appears
        _tvFocusSweep: function (root) {
            root.querySelectorAll('button, input, select, iframe, [tabindex="0"]').forEach(function (el) {
                el.classList.add('show-focus');
            });
        },

        // ── Text-to-Speech (Web Speech API v1) ───────────────────────────────

        _toggleTts: function () {
            // Unlock while still inside the tap/click gesture — iOS only
            // allows programmatic play() on an element that has already
            // played during a real user gesture. Idempotent; also covers
            // resuming into a Piper voice that wasn't active at start.
            this._unlockAudio();

            if (this._ttsPlaying && !this._ttsPaused) {
                if (this._piperAudio) {
                    this._piperAudio.pause();
                } else if (this._isTvVoice() && this._getTvTtsApi() === 'tizen' && this._tizenTtsId !== null) {
                    try { window.webapis.tts.pause(this._tizenTtsId); } catch (e) {}
                } else if (this._isTvVoice()) {
                    this._stopTvTts(); // webOS has no pause — stop and resume from offset
                } else if (typeof window.speechSynthesis !== 'undefined') {
                    window.speechSynthesis.pause();
                }
                this._ttsPaused = true;
                this._updateTtsButtons();
            } else if (this._ttsPaused) {
                // Voice changed while paused → the old stream was discarded;
                // start fresh from the saved offset with the new settings.
                if ((this._isPiperVoice() && !this._piperAudio) ||
                    (!this._isPiperVoice() && !this._isTvVoice() && !this._ttsUtterance)) {
                    this._ttsPaused = false;
                    this._ttsPlaying = false;
                    this._startTts();
                    return;
                }
                if (this._piperAudio) {
                    this._piperAudio.play();
                } else if (this._isTvVoice() && this._getTvTtsApi() === 'tizen' && this._tizenTtsId !== null) {
                    try { window.webapis.tts.resume(this._tizenTtsId); } catch (e) {}
                    this._resumeHlTicker();
                    this._ttsPaused = false;
                    this._updateTtsButtons();
                    return;
                } else if (this._isTvVoice()) {
                    // webOS: restart from saved offset
                    this._ttsPaused = false;
                    this._ttsPlaying = false;
                    this._startTts();
                    return;
                } else if (typeof window.speechSynthesis !== 'undefined') {
                    window.speechSynthesis.resume();
                    this._resumeHlTicker();
                }
                this._ttsPaused = false;
                this._updateTtsButtons();
            } else {
                this._ttsContinuous = true;
                this._startTts();
            }
        },

        // Create the persistent Piper <audio> element and bless it for iOS by
        // playing a ~1ms silent WAV synchronously inside the user gesture.
        // All later streams (including chapter auto-advance) reuse this element.
        _unlockAudio: function () {
            if (this._piperAudioEl) return;
            var a = new Audio();
            a.preload = 'auto';
            a.src = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';
            var p = a.play();
            if (p && p.catch) p.catch(function () {});
            this._piperAudioEl = a;
        },

        // Ensure the chapter's text/offset map exists; returns the map.
        _ensureOffsetMap: function () {
            var frame = document.getElementById('abr-frame');
            var doc = frame.contentDocument;
            if (!this._ttsFullText) {
                var built = this._buildOffsetMap(doc);
                this._ttsOffsetMap = built.map;
                this._ttsFullText = built.text;
            }
            return this._ttsOffsetMap;
        },

        // Char offset where a given block starts (for TTS start points).
        _paraCharOffset: function (para) {
            try {
                var doc = document.getElementById('abr-frame').contentDocument;
                var map = this._ensureOffsetMap();
                if (para === null || para <= 0) return 0;
                var block = this._getBlocks(doc)[para];
                if (!block) return 0;
                for (var i = 0; i < map.length; i++) {
                    if (block.contains(map[i].node)) return map[i].absStart;
                }
            } catch (e) {}
            return 0;
        },

        // Block index containing the text being SPOKEN right now (live engine
        // offset, same per-engine capture the voice-change handler uses).
        _currentTtsBlock: function () {
            if (!this._ttsPlaying && !this._ttsPaused) return null;
            try {
                var abs = this._ttsCharOffset;
                if (this._piperAudio && this._piperLastAbs != null) {
                    // Real-timing manifest: the last highlighted absolute offset
                    abs = this._piperLastAbs;
                } else if (this._hlTicker && this._hlTickLast != null) {
                    abs = this._hlTickLast;
                } else {
                    abs += this._ttsLastBoundary;
                }
                var entry = this._findMapEntry(abs);
                if (!entry) return null;
                var doc = document.getElementById('abr-frame').contentDocument;
                var blocks = this._getBlocks(doc);
                for (var i = 0; i < blocks.length; i++) {
                    if (blocks[i].contains(entry.node)) return i;
                }
            } catch (e) {}
            return null;
        },

        // Character offset of the first VISIBLE character — uses the caret at
        // the top-left of the visible reading area, so a paragraph continued
        // from the previous page is read from its continuation, not skipped.
        _firstVisibleCharOffset: function () {
            try {
                var frame = document.getElementById('abr-frame');
                var doc = frame.contentDocument, win = frame.contentWindow;
                this._ensureOffsetMap();
                var cs = win.getComputedStyle(doc.body);
                var x = (parseFloat(cs.paddingLeft) || 24) + 2;
                var y = this._viewMode === 'page' ? (parseFloat(cs.paddingTop) || 24) + 2 : 2;
                var node = null, off = 0;
                if (doc.caretRangeFromPoint) {
                    var r = doc.caretRangeFromPoint(x, y);
                    if (r) { node = r.startContainer; off = r.startOffset; }
                } else if (doc.caretPositionFromPoint) {
                    var p = doc.caretPositionFromPoint(x, y);
                    if (p) { node = p.offsetNode; off = p.offset; }
                }
                if (node && node.nodeType === 3) {
                    var map = this._ttsOffsetMap;
                    for (var i = 0; i < map.length; i++) {
                        if (map[i].node === node) {
                            return map[i].absStart + Math.min(off, (node.textContent || '').length);
                        }
                    }
                }
            } catch (e) {}
            // Fallback: first whole paragraph on the page
            return this._paraCharOffset(this._firstVisiblePara());
        },

        _startTts: function () {
            var self = this;
            // Fresh start (not a pause-resume or mid-read restart): begin at the
            // resumed paragraph if one is pending, else at the first VISIBLE
            // CHARACTER (handles partial paragraphs at a page top).
            if (!self._ttsPaused && self._ttsCharOffset === 0) {
                if (self._ttsStartPara !== null && self._ttsStartPara !== undefined) {
                    self._ttsCharOffset = self._paraCharOffset(self._ttsStartPara);
                    self._ttsStartPara = null;
                } else {
                    self._ttsCharOffset = self._firstVisibleCharOffset();
                }
            }
            // Update the place continuously WHILE reading (every 10s): a
            // crash, TV power-off, or app kill mid-listen loses nothing.
            if (self._ttsSaveTimer) clearInterval(self._ttsSaveTimer);
            self._ttsSaveTimer = setInterval(function () {
                if (!self._ttsPlaying) return;
                var spoken = self._currentTtsBlock();
                if (spoken !== null) {
                    self._ttsStartPara = spoken;
                    self._saveProgress(self._chapterIndex, self._currentScrollFraction(), spoken);
                }
            }, 10000);
            if (self._isPiperVoice()) { self._startPiperTts(); return; }
            if (self._isTvVoice()) { self._startTvTts(); return; }

            var frame = document.getElementById('abr-frame');
            if (!frame || !frame.contentDocument) return;

            // Build text + offset map once per chapter; reuse on mid-read
            // restarts — but never reuse a STALE map (trimmed + re-stitched
            // scroll sections leave it pointing at detached nodes)
            if (!self._ttsFullText || self._offsetMapStale()) {
                try {
                    var built = self._buildOffsetMap(frame.contentDocument);
                    self._ttsOffsetMap = built.map;
                    self._ttsFullText = built.text;
                } catch (e) { return; }
            }

            var text = self._ttsFullText.slice(self._ttsCharOffset);
            self._ttsLastBoundary = 0;

            if (!text) {
                // Blank / graphic chapter — skip forward
                if (self._ttsContinuous) {
                    var skipNext = self._chapterIndex + 1;
                    if (skipNext < self._spine.length) {
                        self._loadChapter(skipNext);
                    } else {
                        self._ttsContinuous = false;
                        self._updateTtsButtons();
                        var skipInfo = document.getElementById('abr-chapter-info');
                        if (skipInfo) skipInfo.textContent = 'End of book';
                    }
                }
                return;
            }

            window.speechSynthesis.cancel();

            var utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = self._ttsRate;
            utterance.pitch = 1.0;
            utterance.lang = document.documentElement.lang || 'en';

            // Apply selected voice
            if (self._ttsVoiceURI) {
                var voices = window.speechSynthesis.getVoices();
                for (var i = 0; i < voices.length; i++) {
                    if (voices[i].voiceURI === self._ttsVoiceURI) {
                        utterance.voice = voices[i];
                        break;
                    }
                }
            }

            utterance.onboundary = function (e) {
                if (e.charIndex != null) {
                    // Real word events — the estimating ticker stands down
                    self._ttsBoundarySeen = true;
                    self._stopHlTicker();
                    self._ttsLastBoundary = e.charIndex;
                    var abs = self._ttsCharOffset + e.charIndex;
                    var len = e.charLength;
                    if (!len || len < 1) {
                        var w = self._snapToWord(abs);
                        if (w) { abs = w.start; len = w.len; }
                        else { len = 1; }
                    }
                    self._highlightWord(frame, abs, len);
                }
            };
            utterance.onstart = function () {
                self._ttsPlaying = true;
                self._ttsPaused = false;
                self._updateTtsButtons();
                // iOS/TV browsers never fire onboundary — estimate until (if
                // ever) a real boundary event arrives
                if (!self._ttsBoundarySeen) self._startHlTicker(self._ttsRate);
            };
            utterance.onend = function () {
                // iOS Safari fires onend when cancel() runs during navigation.
                // Only the CURRENT utterance's real end may advance chapters;
                // a stale/canceled one is ignored (prevents spurious loops).
                if (utterance !== self._ttsUtterance) return;
                self._stopHlTicker();
                self._ttsPlaying = false;
                self._ttsPaused = false;
                self._ttsUtterance = null;
                self._ttsCharOffset = 0;
                self._ttsFullText = '';
                self._ttsLastBoundary = 0;
                self._ttsOffsetMap = [];
                self._clearTtsSelection(frame);

                if (self._ttsContinuous) {
                    var next = self._chapterIndex + 1;
                    if (next < self._spine.length) {
                        self._loadChapter(next);
                    } else {
                        self._ttsContinuous = false;
                        self._updateTtsButtons();
                        var info = document.getElementById('abr-chapter-info');
                        if (info) info.textContent = 'End of book';
                    }
                } else {
                    self._updateTtsButtons();
                }
            };
            utterance.onerror = function (e) {
                // 'canceled' fires on chapter transitions — not a real error
                if (e.error === 'canceled' || e.error === 'interrupted') return;
                self._stopHlTicker();
                self._ttsPlaying = false;
                self._ttsPaused = false;
                self._ttsContinuous = false;
                self._ttsCharOffset = 0;
                self._ttsFullText = '';
                self._ttsLastBoundary = 0;
                self._ttsOffsetMap = [];
                self._clearTtsSelection(frame);
                self._updateTtsButtons();
            };

            self._ttsUtterance = utterance;
            self._ttsBoundarySeen = false;
            window.speechSynthesis.speak(utterance);
        },

        _stopTts: function () {
            // Capture the spoken position BEFORE teardown wipes the engine
            // state: Stop must keep the reader's place, in-session and saved.
            var spoken = this._currentTtsBlock();
            if (spoken !== null) {
                this._ttsStartPara = spoken;   // Play-after-Stop resumes here
                this._saveProgress(this._chapterIndex, this._currentScrollFraction(), spoken);
            }
            if (this._ttsSaveTimer) { clearInterval(this._ttsSaveTimer); this._ttsSaveTimer = null; }
            this._piperLastAbs = null;
            this._ttsContinuous = false;
            this._stopHlTicker();
            this._stopPiperTts();
            this._stopTvTts();
            if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
            this._ttsPlaying = false;
            this._ttsPaused = false;
            this._ttsUtterance = null;
            this._ttsCharOffset = 0;
            this._ttsFullText = '';
            this._ttsLastBoundary = 0;
            this._ttsOffsetMap = [];
            this._clearTtsSelection(document.getElementById('abr-frame'));
            this._updateTtsButtons();
        },

        // ── Word highlighting ────────────────────────────────────────────────

        // Walk the iframe DOM, building text + a map of text-node char ranges.
        // Block elements contribute a '\n' separator so the speech engine pauses
        // naturally at paragraph breaks; offsets in the map match the text string.
        _buildOffsetMap: function (doc) {
            var map = [];
            var text = '';
            var BLOCK = /^(P|DIV|H[1-6]|LI|TR|TD|TH|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|MAIN|NAV|ASIDE|FIGURE|FIGCAPTION)$/;
            function walk(node) {
                if (node.nodeType === 3) {
                    var t = node.textContent;
                    if (t.length) { map.push({node: node, absStart: text.length, absEnd: text.length + t.length}); text += t; }
                } else if (node.nodeType === 1) {
                    if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(node.nodeName)) return;
                    if (node.nodeName === 'BR') { text += '\n'; return; }
                    var isBlock = BLOCK.test(node.nodeName);
                    if (isBlock && text.length && text[text.length - 1] !== '\n') text += '\n';
                    for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
                    if (isBlock && text.length && text[text.length - 1] !== '\n') text += '\n';
                }
            }
            // In full-book scroll the doc holds many chapters; TTS reads the
            // ACTIVE section only (advancing section-by-section), so scope the
            // map to it. Other modes use the whole single-chapter body.
            var root = doc && doc.body;
            if (this._viewMode === 'scroll' && doc) {
                var info = this._scrollActiveInfo(doc);
                if (info && info.section) root = info.section;
            }
            if (root) walk(root);
            return {text: text, map: map};
        },

        // A cached offset map is stale when its nodes were removed from the
        // document (scroll-mode section trim + re-stitch). Probe the middle
        // entry — all entries share the section subtree's fate.
        _offsetMapStale: function () {
            var map = this._ttsOffsetMap;
            if (!map || !map.length) return false;
            var mid = map[map.length >> 1];
            return !mid || !mid.node || !mid.node.isConnected;
        },

        _findMapEntry: function (offset) {
            var map = this._ttsOffsetMap;
            var lo = 0, hi = map.length - 1;
            while (lo <= hi) {
                var mid = (lo + hi) >> 1;
                if (map[mid].absEnd <= offset) lo = mid + 1;
                else if (map[mid].absStart > offset) hi = mid - 1;
                else return map[mid];
            }
            return map[lo] || null;
        },

        // Draws a floated overlay box over the word instead of a text selection:
        // TV browsers and WKWebView don't render programmatic selections, and
        // wrapping spans would mutate the text nodes the offset map points into.
        _highlightWord: function (frame, offset, length) {
            try {
                var iframeDoc = frame && frame.contentDocument;
                var iframeWin = frame && frame.contentWindow;
                if (!iframeDoc || !iframeDoc.body || !iframeWin) return;

                var entry = this._findMapEntry(offset);
                if (!entry) return;
                // Section re-stitched MID-READ: the node is detached, so the
                // range would paint nowhere. Identical content re-stitches to
                // identical offsets — rebuild the map and carry on.
                if (entry.node && !entry.node.isConnected) {
                    var rebuilt = this._buildOffsetMap(iframeDoc);
                    if (rebuilt.text !== this._ttsFullText) return; // different section is active — let the restart path handle it
                    this._ttsOffsetMap = rebuilt.map;
                    entry = this._findMapEntry(offset);
                    if (!entry || !entry.node || !entry.node.isConnected) return;
                }
                var nodeOff = offset - entry.absStart;
                var nodeEnd = Math.min(nodeOff + (length || 1), entry.node.textContent.length);
                if (nodeEnd <= nodeOff) return;

                var range = iframeDoc.createRange();
                range.setStart(entry.node, nodeOff);
                range.setEnd(entry.node, nodeEnd);
                var rect = range.getBoundingClientRect();
                if (!rect || (rect.width === 0 && rect.height === 0)) return;

                var ds = this._ds || this._dsDefaults;
                var hlBg = ds.HlBg || '#ffd700', hlFg = ds.HlFg || '#1a1a1a';

                // Preferred: CSS Custom Highlight API — highlights the real text
                // range (always correctly positioned, even across page columns)
                // and supports both text color and background. (Safari/iOS 17.2+)
                if (iframeWin.CSS && iframeWin.CSS.highlights && iframeWin.Highlight) {
                    var st = iframeDoc.getElementById('abr-hl-style');
                    if (!st) {
                        st = iframeDoc.createElement('style');
                        st.id = 'abr-hl-style';
                        iframeDoc.head.appendChild(st);
                    }
                    st.textContent = '::highlight(abr-tts){background-color:' + hlBg +
                        ';color:' + hlFg + ';}';
                    if (!this._cssHl) {
                        this._cssHl = new iframeWin.Highlight();
                        iframeWin.CSS.highlights.set('abr-tts', this._cssHl);
                    }
                    this._cssHl.clear();
                    this._cssHl.add(range);
                    // Hide the fallback box if it exists
                    var ob = iframeDoc.getElementById('abr-hl-box');
                    if (ob) ob.style.display = 'none';
                    // Page-following still uses the range rect
                    if (this._viewMode === 'page') {
                        var bR = iframeDoc.body.getBoundingClientRect();
                        var lx = rect.left - bR.left;
                        var tp = Math.max(0, Math.min(this._pageCount - 1,
                            Math.floor(lx / this._pageStep)));
                        if (tp !== this._page) this._goToPage(tp);
                    } else {
                        this._followScroll(iframeWin, iframeDoc, entry.node);
                    }
                    return;
                }

                // Fallback: overlay box (background only — older browsers)
                var box = iframeDoc.getElementById('abr-hl-box');
                if (!box) {
                    box = iframeDoc.createElement('div');
                    box.id = 'abr-hl-box';
                    box.style.cssText = 'position:absolute;pointer-events:none;' +
                        'border-radius:2px;mix-blend-mode:multiply;z-index:2147483647;' +
                        (this._reducedMotion ? '' : 'transition:left 80ms,top 80ms,width 80ms;');
                    iframeDoc.body.appendChild(box);
                }
                box.style.background = hlBg;
                if (this._viewMode === 'page') {
                    // The transformed body is the box's containing block, so
                    // position in body-layout space: viewport rect minus the
                    // body's (transform-inclusive) rect. Viewport coords here
                    // would land the box one page-width off per page.
                    var bodyRect = iframeDoc.body.getBoundingClientRect();
                    box.style.left = (rect.left - bodyRect.left - 1) + 'px';
                    box.style.top = (rect.top - bodyRect.top - 1) + 'px';
                } else {
                    var sx = iframeWin.pageXOffset || 0;
                    var sy = iframeWin.pageYOffset || 0;
                    box.style.left = (rect.left + sx - 1) + 'px';
                    box.style.top = (rect.top + sy - 1) + 'px';
                }
                box.style.width = (rect.width + 2) + 'px';
                box.style.height = (rect.height + 2) + 'px';
                box.style.display = 'block';

                // Follow the reading: turn the page (paged) / scroll (scroll).
                // NEVER scrollIntoView in paged mode — it drags the html
                // element to arbitrary offsets and breaks page alignment.
                if (this._viewMode === 'page') {
                    var bRect = iframeDoc.body.getBoundingClientRect();
                    var layoutX = rect.left - bRect.left;
                    var targetPage = Math.max(0, Math.min(this._pageCount - 1,
                        Math.floor(layoutX / this._pageStep)));
                    if (targetPage !== this._page) this._goToPage(targetPage);
                } else {
                    this._followScroll(iframeWin, iframeDoc, entry.node);
                }
            } catch (e) {}
        },

        _clearTtsSelection: function (frame) {
            try {
                if (frame && frame.contentWindow && this._cssHl) {
                    this._cssHl.clear();
                }
                if (frame && frame.contentDocument) {
                    var box = frame.contentDocument.getElementById('abr-hl-box');
                    if (box) box.style.display = 'none';
                }
            } catch (e) {}
            this._hlPara = null;   // next highlight re-anchors the page to its paragraph
        },

        // Move the page only when the spoken text reaches a NEW paragraph — not
        // on every audio tick. Re-positioning mid-paragraph is what made the
        // view keep scrolling/jumping around the highlighted word.
        _followScroll: function (iframeWin, iframeDoc, node) {
            var BLOCK = /^(P|DIV|H[1-6]|LI|TR|TD|TH|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|MAIN|NAV|ASIDE|FIGURE|FIGCAPTION|PRE)$/;
            var block = node && node.parentElement;
            while (block && !BLOCK.test(block.nodeName)) block = block.parentElement;
            if (!block || block === this._hlPara) return;   // same paragraph → leave the page where it is
            this._hlPara = block;
            var vh = iframeWin.innerHeight || iframeDoc.documentElement.clientHeight || 0;
            if (!vh) return;
            var r = block.getBoundingClientRect();
            if (r.top >= vh * 0.12 && r.top <= vh * 0.55) return;   // new paragraph already well placed
            var cur = iframeWin.pageYOffset || iframeDoc.documentElement.scrollTop || 0;
            var target = cur + r.top - vh * 0.25;
            if (target < 0) target = 0;
            try {
                iframeWin.scrollTo({ top: target, behavior: this._reducedMotion ? 'auto' : 'smooth' });
            } catch (e) {
                try { iframeWin.scrollTo(0, target); } catch (e2) {}
            }
        },

        // Expand an estimated char offset to whole-word boundaries in _ttsFullText
        // (estimates land mid-word; highlighting single letters reads as noise)
        _snapToWord: function (offset) {
            var t = this._ttsFullText;
            if (!t) return null;
            var s = Math.max(0, Math.min(offset, t.length - 1));
            if (/\s/.test(t[s])) {
                while (s < t.length && /\s/.test(t[s])) s++;
                if (s >= t.length) return null;
            }
            var e = s;
            while (s > 0 && /\S/.test(t[s - 1])) s--;
            while (e < t.length && /\S/.test(t[e])) e++;
            return {start: s, len: e - s};
        },

        // ── Estimated-highlight ticker (platforms without word events) ───────

        _startHlTicker: function (rate) {
            var self = this;
            self._stopHlTicker();
            self._hlTickRate = rate || 1.0;
            self._hlTickBase = self._ttsCharOffset;
            self._hlTickStart = Date.now();
            self._hlTickLast = null;
            self._hlTicker = setInterval(function () {
                if (!self._ttsPlaying || self._ttsPaused) return;
                var frame = document.getElementById('abr-frame');
                if (!frame || !self._ttsFullText) return;
                var elapsed = (Date.now() - self._hlTickStart) / 1000;
                // Same ~15 chars/sec speech-rate model the Piper estimate uses
                var absOff = self._hlTickBase + Math.floor(elapsed * 15 * self._hlTickRate);
                if (absOff >= self._ttsFullText.length) { self._stopHlTicker(); return; }
                var w = self._snapToWord(absOff);
                if (w) {
                    self._hlTickLast = w.start;
                    self._highlightWord(frame, w.start, w.len);
                }
            }, 250);
        },

        _stopHlTicker: function () {
            if (this._hlTicker) {
                clearInterval(this._hlTicker);
                this._hlTicker = null;
            }
        },

        // Re-base the clock after a pause so elapsed wall-time during the pause
        // doesn't fast-forward the highlight
        _resumeHlTicker: function () {
            if (!this._hlTicker) return;
            if (this._hlTickLast != null) this._hlTickBase = this._hlTickLast;
            this._hlTickStart = Date.now();
        },

        // No argument — reads _ttsPlaying / _ttsPaused directly for three-state display
        _updateTtsButtons: function () {
            var toggleBtn = document.getElementById('abr-tts-toggle');
            var stopBtn = document.getElementById('abr-tts-stop');
            if (!toggleBtn) return;

            if (this._ttsPlaying && !this._ttsPaused) {
                toggleBtn.setAttribute('aria-label', 'Pause audio');
                toggleBtn.setAttribute('aria-pressed', 'true');
                toggleBtn.innerHTML = '<span class="material-icons" aria-hidden="true">pause</span>';
                toggleBtn.classList.add('abr-tts-active');
                toggleBtn.classList.remove('abr-tts-paused');
                if (stopBtn) stopBtn.removeAttribute('hidden');
            } else if (this._ttsPaused) {
                toggleBtn.setAttribute('aria-label', 'Resume audio');
                toggleBtn.setAttribute('aria-pressed', 'true');
                toggleBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
                toggleBtn.classList.remove('abr-tts-active');
                toggleBtn.classList.add('abr-tts-paused');
                if (stopBtn) stopBtn.removeAttribute('hidden');
            } else {
                toggleBtn.setAttribute('aria-label', 'Play audio');
                toggleBtn.setAttribute('aria-pressed', 'false');
                toggleBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
                toggleBtn.classList.remove('abr-tts-active', 'abr-tts-paused');
                if (stopBtn) stopBtn.setAttribute('hidden', '');
            }
        },

        _populateVoices: function (attempt) {
            var self = this;
            var select = document.getElementById('abr-voice-select');
            if (!select) return;

            var hasSpeech = typeof window.speechSynthesis !== 'undefined';
            var browserVoices = hasSpeech ? window.speechSynthesis.getVoices() : [];
            if (hasSpeech && browserVoices.length === 0 && (attempt || 0) < 20) {
                setTimeout(function () { self._populateVoices((attempt || 0) + 1); }, 250);
                // Fall through — still try to add Piper voices even if browser list is empty
            }

            // Piper voices are static for the session, so fetch them ONCE and
            // cache. Without this, the browser-voice retry above re-requested
            // /piper/voices on every attempt (up to 20×) when the browser voice
            // list loads slowly or is empty (headless, some TVs).
            if (self._piperVoiceCache) {
                self._buildVoiceSelect(document.getElementById('abr-voice-select'),
                    hasSpeech ? window.speechSynthesis.getVoices() : [], self._piperVoiceCache);
                return;
            }
            if (self._piperVoiceFetching) {
                // A fetch is already in flight; just reflect the latest browser voices.
                self._buildVoiceSelect(document.getElementById('abr-voice-select'), browserVoices, []);
                return;
            }
            self._piperVoiceFetching = true;
            ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/piper/voices'),
                type: 'GET',
                dataType: 'json'
            }).then(function (piperVoices) {
                self._piperVoiceCache = piperVoices || [];
                self._piperVoiceFetching = false;
                var fresh = hasSpeech ? window.speechSynthesis.getVoices() : [];
                self._buildVoiceSelect(document.getElementById('abr-voice-select'), fresh, self._piperVoiceCache);
            }).catch(function () {
                self._piperVoiceFetching = false;
                self._buildVoiceSelect(document.getElementById('abr-voice-select'), browserVoices, []);
            });
        },

        _buildVoiceSelect: function (select, browserVoices, piperVoices) {
            if (!select) return;
            var currentURI = this._ttsVoiceURI;

            // No saved voice: default to a Piper voice (server-side, identical on
            // every platform) instead of the browser/system default, which is
            // SILENT on TVs and headless browsers. Priority: bundled Ryan >
            // first Piper > TV built-in > first browser voice. While the Piper
            // list is still in flight, don't commit a fallback — a fast browser
            // voice list would otherwise win the save over Piper.
            if (!currentURI && !this._piperVoiceFetching) {
                if (piperVoices && piperVoices.length > 0) {
                    var ryan = null;
                    for (var pi = 0; pi < piperVoices.length; pi++) {
                        if (piperVoices[pi].key === 'en_US-ryan-medium') { ryan = piperVoices[pi]; break; }
                    }
                    currentURI = 'piper:' + (ryan ? ryan.key : piperVoices[0].key);
                } else if (this._getTvTtsApi()) {
                    currentURI = 'tv:builtin';
                } else if (browserVoices && browserVoices.length > 0) {
                    currentURI = browserVoices[0].voiceURI;
                }
                if (currentURI) {
                    this._ttsVoiceURI = currentURI;
                    this._saveSettings();
                }
            }
            select.innerHTML = '';

            // Piper voices first — server-side, so they're the only voices that
            // sound identical on every platform (web, iOS, TV).
            if (piperVoices && piperVoices.length > 0) {
                var pg = document.createElement('optgroup');
                pg.label = 'Piper voices (high quality)';
                piperVoices.forEach(function (v) {
                    var opt = document.createElement('option');
                    opt.value = 'piper:' + v.key;
                    opt.textContent = v.displayName;
                    if ('piper:' + v.key === currentURI) opt.selected = true;
                    pg.appendChild(opt);
                });
                select.appendChild(pg);
            }

            // TV built-in voice (Samsung Tizen / LG webOS)
            var tvApi = this._getTvTtsApi();
            if (tvApi) {
                var tvg = document.createElement('optgroup');
                tvg.label = tvApi === 'tizen' ? 'Samsung TV voice' : 'LG TV voice';
                var tvOpt = document.createElement('option');
                tvOpt.value = 'tv:builtin';
                tvOpt.textContent = 'TV Built-in Voice';
                if (currentURI === 'tv:builtin') tvOpt.selected = true;
                tvg.appendChild(tvOpt);
                select.appendChild(tvg);
            }

            // Browser voices optgroup — no implicit '' "Default" entry: the
            // system-default voice is unpredictable per platform (and absent on
            // TVs/headless), so every selectable option is now a concrete voice.
            var bg = document.createElement('optgroup');
            bg.label = 'Browser voices';
            browserVoices.forEach(function (v) {
                var opt = document.createElement('option');
                opt.value = v.voiceURI;
                opt.textContent = v.name + (v.localService ? '' : ' ☁');
                if (v.voiceURI === currentURI) opt.selected = true;
                bg.appendChild(opt);
            });
            select.appendChild(bg);
        },

        // ── Piper audio playback ──────────────────────────────────────────────

        _isPiperVoice: function () {
            return typeof this._ttsVoiceURI === 'string' && this._ttsVoiceURI.indexOf('piper:') === 0;
        },

        // Piper TTS with REAL per-sentence timing. The server STREAMS the audio
        // as MP3 (fast start, iOS-compatible) with the speed baked in (ffmpeg
        // atempo), and fills a per-sentence timing manifest *as it streams* —
        // measured from the exact audio being played, in output time. The client
        // streams the audio and polls the manifest; the highlight re-syncs every
        // sentence with zero drift. Speed change = re-stream from current pos.
        _startPiperTts: function () {
            var self = this;
            var frame = document.getElementById('abr-frame');
            if (!frame) return;

            // Rebuild when empty OR STALE: scroll mode trims and re-stitches
            // sections, leaving a cached map that points at DETACHED nodes —
            // the Highlight API accepts ranges on them but paints nothing
            // (highlights silently vanish and stop/start can't recover).
            if (!self._ttsFullText || self._offsetMapStale()) {
                try {
                    var built = self._buildOffsetMap(frame.contentDocument);
                    self._ttsOffsetMap = built.map;
                    self._ttsFullText = built.text;
                } catch (e) { return; }
            }

            var text = self._ttsFullText.slice(self._ttsCharOffset);
            if (!text.trim()) {
                if (self._ttsContinuous) {
                    var next = self._chapterIndex + 1;
                    if (next < self._spine.length) { self._ttsAdvanceChapter(next); }
                    else { self._ttsContinuous = false; self._updateTtsButtons(); }
                }
                return;
            }

            var voiceKey = self._ttsVoiceURI.slice(6);
            var base = self._ttsCharOffset;
            self._hlPara = null;   // re-anchor the page to the first spoken paragraph
            self._ttsPlaying = true;
            self._updateTtsButtons();

            var token = (typeof ApiClient !== 'undefined' && ApiClient.accessToken) ? ApiClient.accessToken() : '';

            // Step 1: register the text, get a session id.
            var xhr = new XMLHttpRequest();
            xhr.open('POST', ApiClient.getUrl('A11yBookReader/tts/prepare'));
            xhr.setRequestHeader('Content-Type', 'application/json');
            if (token) xhr.setRequestHeader('X-Emby-Authorization', 'MediaBrowser Token="' + token + '"');
            xhr.responseType = 'json';
            self._piperXhr = xhr;
            xhr.onload = function () {
                self._piperXhr = null;
                var id = (xhr.status === 200 && xhr.response) ? xhr.response.id : null;
                if (!id) { self._ttsPlaying = false; self._updateTtsButtons(); return; }

                // Step 2: stream the audio (fast start, browser plays as bytes arrive).
                var url = ApiClient.getUrl('A11yBookReader/tts/stream/' + id, token ? { api_key: token } : {});
                var audio = self._piperAudioEl || (self._piperAudioEl = new Audio());
                audio.ontimeupdate = null; audio.onended = null; audio.onerror = null;
                try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
                audio.playbackRate = 1;                  // speed is baked server-side (ffmpeg atempo); iOS ignores playbackRate on a live stream. Manifest is in output time, so currentTime aligns.
                audio.abrSpans = [];                      // grows via polling
                audio.abrBase = base;
                self._piperAudio = audio;

                // Step 3: poll the growing timing manifest (synthesis ~15x realtime
                // stays well ahead of playback, so accurate highlight kicks in fast).
                if (self._piperPoll) { clearInterval(self._piperPoll); }
                var pollUrl = ApiClient.getUrl('A11yBookReader/tts/timing/' + id, token ? { api_key: token } : {});
                self._piperPoll = setInterval(function () {
                    if (audio !== self._piperAudio) { clearInterval(self._piperPoll); self._piperPoll = null; return; }
                    ApiClient.ajax({ url: pollUrl, type: 'GET', dataType: 'json' }).then(function (r) {
                        if (audio !== self._piperAudio) return;
                        var spans = (r.spans || r.Spans || []).map(function (s) {
                            return {
                                cs: s.CharStart != null ? s.CharStart : s.charStart,
                                ce: s.CharEnd != null ? s.CharEnd : s.charEnd,
                                s: s.StartMs != null ? s.StartMs : s.startMs,
                                e: s.EndMs != null ? s.EndMs : s.endMs
                            };
                        });
                        // Never shrink: a transient short manifest (the server
                        // resets its span list on an iOS re-fetch) must not yank
                        // the highlight backward. Spans only grow legitimately.
                        if (spans.length >= (audio.abrSpans ? audio.abrSpans.length : 0)) audio.abrSpans = spans;
                        if ((r.done || r.Done) && self._piperPoll) { clearInterval(self._piperPoll); self._piperPoll = null; }
                    }).catch(function () {});
                }, 700);

                audio.ontimeupdate = function () {
                    if (audio.paused || audio.seeking || audio.readyState < 2) return;
                    self._piperHighlight(frame, audio);
                };

                audio.onended = function () {
                    if (audio !== self._piperAudio) return;
                    if (self._piperPoll) { clearInterval(self._piperPoll); self._piperPoll = null; }
                    self._piperAudio = null;
                    self._ttsCharOffset = 0;
                    self._clearTtsSelection(frame);
                    if (self._ttsContinuous) {
                        var nc = self._chapterIndex + 1;
                        if (nc < self._spine.length) { self._ttsAdvanceChapter(nc); }
                        else {
                            self._ttsContinuous = false; self._ttsPlaying = false; self._updateTtsButtons();
                            var ei = document.getElementById('abr-chapter-info');
                            if (ei) ei.textContent = 'End of book';
                        }
                    } else { self._ttsPlaying = false; self._updateTtsButtons(); }
                };

                audio.onerror = function () {
                    if (audio !== self._piperAudio) return;
                    if (self._piperPoll) { clearInterval(self._piperPoll); self._piperPoll = null; }
                    self._piperAudio = null;
                    self._ttsPlaying = false; self._ttsPaused = false;
                    self._ttsContinuous = false; self._updateTtsButtons();
                };

                audio.src = url;
                var played = audio.play();
                if (played && played.catch) {
                    played.catch(function () {
                        self._piperAudio = null;
                        self._ttsPlaying = false; self._ttsPaused = false;
                        self._ttsContinuous = false; self._updateTtsButtons();
                    });
                }
            };
            xhr.onerror = function () {
                self._piperXhr = null;
                self._ttsPlaying = false; self._updateTtsButtons();
            };
            xhr.send(JSON.stringify({ text: text, voice: voiceKey, rate: self._ttsRate }));
        },

        _piperHighlight: function (frame, audio) {
            var spans = audio.abrSpans;
            if (!spans || !spans.length) return;
            var t = audio.currentTime * 1000; // media-time ms (1×)
            // binary search for the span containing t
            var lo = 0, hi = spans.length - 1, idx = -1;
            while (lo <= hi) {
                var mid = (lo + hi) >> 1;
                if (t < spans[mid].s) hi = mid - 1;
                else if (t >= spans[mid].e) lo = mid + 1;
                else { idx = mid; break; }
            }
            if (idx < 0) idx = Math.min(spans.length - 1, Math.max(0, lo));
            var sp = spans[idx];
            var frac = sp.e > sp.s ? Math.min(1, Math.max(0, (t - sp.s) / (sp.e - sp.s))) : 0;
            var wordCharRel = sp.cs + Math.floor(frac * (sp.ce - sp.cs));
            var absOff = audio.abrBase + wordCharRel;
            this._piperLastAbs = absOff;
            var w = this._snapToWord(absOff);
            if (w) this._highlightWord(frame, w.start, w.len);
        },

        _stopPiperTts: function () {
            if (this._piperAudio) {
                var a = this._piperAudio;
                // Clear handlers BEFORE detaching so the src reset doesn't fire
                // onerror; keep the element itself — it stays gesture-blessed
                // for the next stream (chapter auto-advance on iOS).
                a.ontimeupdate = null;
                a.onended = null;
                a.onerror = null;
                a.pause();
                a.removeAttribute('src');
                try { a.load(); } catch (e) {}   // aborts the in-flight stream fetch
                this._piperAudio = null;
            }
            if (this._piperXhr) {
                this._piperXhr.abort();
                this._piperXhr = null;
            }
            if (this._piperPoll) { clearInterval(this._piperPoll); this._piperPoll = null; }
            this._hlPara = null;
        },

        // ── TV Platform TTS (Samsung Tizen / LG webOS) ───────────────────────────

        _getTvTtsApi: function () {
            if (window.webapis && window.webapis.tts && typeof window.webapis.tts.speak === 'function') return 'tizen';
            if (window.webOS && window.webOS.service) return 'webos';
            if (/web0s|webos/i.test(navigator.userAgent || '')) return 'webos';
            return null;
        },

        _isTvVoice: function () {
            return this._ttsVoiceURI === 'tv:builtin';
        },

        _startTvTts: function () {
            var self = this;
            var frame = document.getElementById('abr-frame');
            if (!frame) return;

            if (!self._ttsFullText) {
                try {
                    var built = self._buildOffsetMap(frame.contentDocument);
                    self._ttsOffsetMap = built.map;
                    self._ttsFullText = built.text;
                } catch (e) { return; }
            }

            var text = self._ttsFullText.slice(self._ttsCharOffset).trim();
            if (!text) {
                if (self._ttsContinuous) {
                    var next = self._chapterIndex + 1;
                    if (next < self._spine.length) { self._ttsAdvanceChapter(next); }
                    else { self._ttsContinuous = false; self._updateTtsButtons(); }
                }
                return;
            }

            var lang = (document.documentElement.lang || 'en-US').replace('-', '_');
            var api = self._getTvTtsApi();

            if (api === 'tizen') {
                try {
                    var id = window.webapis.tts.speak(text, lang, self._ttsRate, 1.0);
                    self._tizenTtsId = id;
                    self._ttsPlaying = true;
                    self._updateTtsButtons();
                    self._startHlTicker(self._ttsRate); // TV APIs emit no word events
                    window.webapis.tts.addEventCallback(id, {
                        onComplete: function () { self._onTvTtsEnd(); },
                        onStop: function () {
                            self._tizenTtsId = null;
                            self._ttsPlaying = false;
                            self._ttsPaused = false;
                            self._updateTtsButtons();
                        },
                        onError: function () {
                            self._tizenTtsId = null;
                            self._ttsPlaying = false;
                            self._ttsPaused = false;
                            self._ttsContinuous = false;
                            self._updateTtsButtons();
                        }
                    });
                } catch (e) {
                    self._ttsPlaying = false;
                    self._updateTtsButtons();
                }
            } else if (api === 'webos') {
                self._ttsPlaying = true;
                self._updateTtsButtons();
                self._startHlTicker(1.0); // webOS speak() has no rate parameter
                var subId = ++self._webosSubId;
                try {
                    window.webOS.service.request('luna://com.webos.service.tts', {
                        method: 'speak',
                        parameters: { text: text, language: lang.replace('_', '-'), clear: true },
                        onSuccess: function () {},
                        onFailure: function () { self._ttsPlaying = false; self._updateTtsButtons(); }
                    });
                    window.webOS.service.request('luna://com.webos.service.tts', {
                        method: 'getStatus',
                        parameters: { subscribe: true },
                        onSuccess: function (s) {
                            if (subId !== self._webosSubId) return;
                            if (s.status === 'idle' && self._ttsPlaying && !self._ttsPaused) {
                                self._onTvTtsEnd();
                            }
                        },
                        onFailure: function () {}
                    });
                } catch (e) {
                    self._ttsPlaying = false;
                    self._updateTtsButtons();
                }
            }
        },

        _stopTvTts: function () {
            var api = this._getTvTtsApi();
            if (api === 'tizen' && this._tizenTtsId !== null) {
                try { window.webapis.tts.stop(this._tizenTtsId); } catch (e) {}
                this._tizenTtsId = null;
            } else if (api === 'webos') {
                this._webosSubId++;
                try {
                    window.webOS.service.request('luna://com.webos.service.tts', {
                        method: 'stop', parameters: {},
                        onSuccess: function () {}, onFailure: function () {}
                    });
                } catch (e) {}
            }
        },

        _onTvTtsEnd: function () {
            var self = this;
            self._stopHlTicker();
            self._tizenTtsId = null;
            self._ttsPlaying = false;
            self._ttsPaused = false;
            self._ttsCharOffset = 0;
            self._ttsFullText = '';
            self._ttsLastBoundary = 0;
            self._ttsOffsetMap = [];
            if (self._ttsContinuous) {
                var next = self._chapterIndex + 1;
                if (next < self._spine.length) {
                    self._ttsAdvanceChapter(next);
                } else {
                    self._ttsContinuous = false;
                    self._updateTtsButtons();
                    var info = document.getElementById('abr-chapter-info');
                    if (info) info.textContent = 'End of book';
                }
            } else {
                self._updateTtsButtons();
            }
        },

        // ── Per-user per-platform settings persistence ────────────────────────

        _getPlatformKey: function () {
            var tv = this._getTvTtsApi();
            if (tv) return tv;
            var ua = navigator.userAgent || '';
            if (/ipad|iphone|ipod/i.test(ua)) return 'ios';
            if (/android/i.test(ua)) return 'android';
            if (/macintosh|mac os x/i.test(ua)) return 'mac';
            if (/windows/i.test(ua)) return 'windows';
            return 'linux';
        },

        _getSettingsKey: function () {
            var userId = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId)
                ? ApiClient.getCurrentUserId() : 'anon';
            return 'abr-settings-' + userId + '-' + this._getPlatformKey();
        },

        // Device-local settings: ONLY the TTS voice (voice URIs are
        // platform-specific). Everything else lives server-side in _ds.
        _loadSettings: function () {
            try {
                var raw = localStorage.getItem(this._getSettingsKey());
                if (!raw) return;
                var s = JSON.parse(raw);
                if (typeof s.voice === 'string') this._ttsVoiceURI = s.voice;
            } catch (e) {}
        },

        _saveSettings: function () {
            try {
                localStorage.setItem(this._getSettingsKey(), JSON.stringify({
                    voice: this._ttsVoiceURI
                }));
            } catch (e) {}
        },

        // ── Display Settings ─────────────────────────────────────────────────

        _fetchDisplaySettings: function () {
            var self = this;
            return ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/settings'),
                type: 'GET',
                dataType: 'json'
            }).then(function (s) {
                self._ds = self._mergeSettings(s);
            }).catch(function () {
                // No server settings yet (or offline): local cache, then defaults.
                // The server runs the authoritative v1→v2 ViewMode migration; the
                // offline cache can't reach it, so migrate the cached blob here
                // once (per-user marker) before it's used, or a legacy 'scroll'
                // (which meant scroll-within-chapter) would teleport the user
                // into the new full-book engine.
                try {
                    var uid = (ApiClient.getCurrentUserId ? ApiClient.getCurrentUserId() : 'anon');
                    var key = 'abr-display-' + uid;
                    var raw = localStorage.getItem(key);
                    var cached = raw ? JSON.parse(raw) : null;
                    if (cached && self._migrateCachedSettings(cached, uid)) {
                        try { localStorage.setItem(key, JSON.stringify(cached)); } catch (e) {}
                    }
                    self._ds = self._mergeSettings(cached);
                } catch (e) { self._ds = self._mergeSettings(null); }
            });
        },

        // Offline-cache mirror of the server's v1→v2 migration. Per-user marker
        // so a later genuine 'scroll' selection is never undone.
        _migrateCachedSettings: function (cached, uid) {
            var SCHEMA = 2;
            var mk = 'abr-schema-' + uid;
            var marker = 0;
            try { marker = parseInt(localStorage.getItem(mk) || '0', 10) || 0; } catch (e) {}
            if (marker >= SCHEMA) return false;
            var changed = false;
            if (cached.ViewMode === 'paged') { cached.ViewMode = 'page'; changed = true; }
            else if (cached.ViewMode === 'scroll') { cached.ViewMode = 'chapter'; changed = true; }
            try { localStorage.setItem(mk, String(SCHEMA)); } catch (e) {}
            return changed;
        },

        // Coerce a stored ViewMode to the 3-way set. Legacy 'paged' is
        // unambiguous; legacy 'scroll' is migrated upstream (server + cache),
        // so a 'scroll' reaching here is the new full-book mode.
        _normalizeViewMode: function (v) {
            if (v === 'page' || v === 'chapter' || v === 'scroll') return v;
            if (v === 'paged') return 'page';
            return 'chapter';
        },

        _normalizeNavUnit: function (v) {
            return (v === 'chapter' || v === 'page' || v === 'heading' ||
                    v === 'paragraph' || v === 'sentence' || v === 'bookmark') ? v : 'chapter';
        },

        _mergeSettings: function (s) {
            var out = {};
            var d = this._dsDefaults;
            for (var k in d) {
                var v = s ? (s[k] !== undefined ? s[k] : s[k.charAt(0).toLowerCase() + k.slice(1)]) : undefined;
                out[k] = (v === undefined || v === null) ? d[k] : v;
            }
            return out;
        },

        // Debounced server save + local cache (offline fallback)
        _saveDisplaySettings: function () {
            var self = this;
            try {
                localStorage.setItem('abr-display-' +
                    (ApiClient.getCurrentUserId ? ApiClient.getCurrentUserId() : 'anon'),
                    JSON.stringify(self._ds));
            } catch (e) {}
            if (self._dsSaveTimer) clearTimeout(self._dsSaveTimer);
            self._dsSaveTimer = setTimeout(function () {
                try {
                    ApiClient.ajax({
                        url: ApiClient.getUrl('A11yBookReader/settings'),
                        type: 'POST',
                        contentType: 'application/json',
                        data: JSON.stringify(self._ds)
                    }).catch(function () {});
                } catch (e) {}
            }, 800);
        },

        // ── Book Map (Phase 3: TOC / pages / landmarks / go-to) ──────────────

        _fetchNav: function () {
            var self = this;
            if (self._nav) return Promise.resolve(self._nav);
            return ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/nav/' + self._currentItemId),
                type: 'GET',
                dataType: 'json'
            }).then(function (n) {
                self._nav = {
                    toc: n.Toc || n.toc || [],
                    landmarks: n.Landmarks || n.landmarks || [],
                    pageList: n.PageList || n.pageList || [],
                    tocGenerated: n.TocGenerated || n.tocGenerated || false
                };
                return self._nav;
            }).catch(function () {
                self._nav = { toc: [], landmarks: [], pageList: [] };
                return self._nav;
            });
        },

        _snapshotLocator: function () {
            return {
                chapter: this._chapterIndex,
                fraction: this._currentScrollFraction(),
                para: this._firstVisiblePara()
            };
        },

        // Any deliberate navigation invalidates a paused/playing TTS session:
        // the next Play must start fresh from the new location, not continue
        // the old paused stream (which holds the pre-jump position).
        _navResetTts: function () {
            // Stop FIRST — _stopTts captures the spoken block into _ttsStartPara —
            // then clear it, or the stale block (from the pre-jump chapter) would
            // misplace the next Play into the new chapter's paragraphs.
            if (this._ttsPlaying || this._ttsPaused) this._stopTts();
            this._ttsStartPara = null;
        },

        // TTS finished a chapter and continuous reading is on. Single-chapter
        // modes reload the frame (which auto-restarts TTS via _ttsContinuous);
        // scroll mode keeps the stitched doc and scrolls to the next section,
        // restarting TTS there once it's laid out.
        _ttsAdvanceChapter: function (next) {
            var self = this;
            if (this._viewMode === 'scroll') {
                this._chapterIndex = next;
                this._scrollGoToAnchor(next, null);
                // The offset map is scoped to the ACTIVE section — drop the old
                // section's cache or the restart re-reads its stale text and the
                // empty-skip path silently walks to the end of the book.
                this._ttsCharOffset = 0;
                this._ttsStartPara = null;
                this._ttsLastBoundary = 0;
                this._ttsFullText = '';
                this._ttsOffsetMap = [];
                // _scrollGoToAnchor may still be loading the target section (it
                // retries for up to 2s); restart TTS only once the target is the
                // active section, or the rebuilt map would capture the old one.
                var tries = 0;
                var iv = setInterval(function () {
                    if (!self._ttsContinuous) { clearInterval(iv); return; }
                    var frame = document.getElementById('abr-frame');
                    var doc = frame && frame.contentDocument;
                    var sec = self._scrollSections && self._scrollSections[next];
                    var arrived = false;
                    if (doc && sec) {
                        var info = self._scrollActiveInfo(doc);
                        arrived = !!(info && info.section === sec);
                    }
                    if (arrived || ++tries > 25) {
                        clearInterval(iv);
                        self._updateTtsButtons(true);
                        self._startTts();
                    }
                }, 100);
            } else {
                this._loadChapter(next);
            }
        },

        // Jump to chapter+anchor; remembers where you came from
        _goToTarget: function (chapter, anchor, pushBack) {
            if (typeof chapter !== 'number' || chapter < 0 || chapter >= this._spine.length) return;
            this._navResetTts(); // Play now resumes from where you jump to
            if (pushBack) {
                this._navStack.push(this._snapshotLocator());
                this._updateBackBtn();
            }
            if (this._viewMode === 'scroll') {
                // Continuous scroll: scroll to the target section (loading it if
                // it isn't resident) rather than reloading the frame.
                this._chapterIndex = chapter;
                this._scrollGoToAnchor(chapter, anchor || null);
                return;
            }
            if (chapter === this._chapterIndex) {
                if (anchor) this._goToAnchor(anchor);
                return;
            }
            this._pendingAnchor = anchor || '';
            this._loadChapter(chapter);
        },

        _goToAnchor: function (anchor) {
            this._navResetTts(); // Play resumes from the link target
            if (this._viewMode === 'scroll') { this._scrollGoToAnchor(this._chapterIndex, anchor); return; }
            try {
                var frame = document.getElementById('abr-frame');
                var doc = frame.contentDocument;
                var el = anchor ? doc.getElementById(anchor) : null;
                if (!el && anchor) {
                    // name= anchors in older books
                    var named = doc.getElementsByName ? doc.getElementsByName(anchor) : [];
                    if (named && named.length) el = named[0];
                }
                if (!el) return;
                if (this._viewMode === 'page') {
                    this._goToPage(Math.max(0, Math.min(this._pageCount - 1,
                        Math.floor(el.offsetLeft / this._pageStep))), true);
                } else {
                    var win = frame.contentWindow;
                    win.scrollTo(0, el.getBoundingClientRect().top + win.pageYOffset - 16);
                    this._updateProgressUI();
                }
            } catch (e) {}
        },

        _goBack: function () {
            var loc = this._navStack.pop();
            this._updateBackBtn();
            if (!loc) return;
            this._navResetTts(); // Play resumes from the returned position
            if (this._viewMode === 'scroll') {
                this._chapterIndex = loc.chapter;
                this._scrollGoToAnchor(loc.chapter, null);
                if (loc.para != null) {
                    var selfRef = this;
                    setTimeout(function () { selfRef._scrollGoToPara(loc.chapter, loc.para); }, 120);
                }
                var infoB = document.getElementById('abr-chapter-info');
                if (infoB) infoB.textContent = 'Returning to your reading position';
                return;
            }
            if (loc.chapter === this._chapterIndex) {
                if (!this._goToPara(loc.para)) {
                    if (this._viewMode === 'page') {
                        this._goToPage(Math.round(loc.fraction * (this._pageCount - 1)), true);
                    }
                }
                var info = document.getElementById('abr-chapter-info');
                if (info) info.textContent = 'Returned to your reading position';
                return;
            }
            this._pendingScrollFraction = loc.fraction;
            this._pendingPara = loc.para;
            this._loadChapter(loc.chapter);
            var info2 = document.getElementById('abr-chapter-info');
            if (info2) info2.textContent = 'Returning to your reading position';
        },

        _updateBackBtn: function () {
            var btn = document.getElementById('abr-back-btn');
            if (!btn) return;
            if (this._navStack.length) btn.removeAttribute('hidden');
            else btn.setAttribute('hidden', '');
        },

        _toggleBookMap: function () {
            var self = this;
            var panel = document.getElementById('abr-bookmap');
            var btn = document.getElementById('abr-bookmap-btn');
            if (!panel) return;
            var opening = panel.hasAttribute('hidden');
            if (!opening) {
                panel.setAttribute('hidden', '');
                if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
                return;
            }
            this._closeOtherPanels('bookmap'); // only one popup open at a time
            panel.removeAttribute('hidden');
            if (btn) btn.setAttribute('aria-expanded', 'true');
            this._fetchNav().then(function () {
                self._renderBookMapTab(self._bookMapTab || 'toc');
                var first = panel.querySelector('.abr-tab');
                if (first) first.focus();
            });
        },

        _buildBookMap: function () {
            var self = this;
            var panel = document.createElement('div');
            panel.id = 'abr-bookmap';
            // A true modal dialog (same presentation + focus trap as Settings) —
            // role=group under-announced it and SRs didn't switch to dialog mode.
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            panel.setAttribute('aria-label', 'Book navigation');
            panel.setAttribute('hidden', '');
            panel.className = 'abr-modal'; // same centered-card style as Settings
            panel.addEventListener('click', function (e) { if (e.target === panel) self._toggleBookMap(); });

            var card = document.createElement('div');
            card.className = 'abr-modal-card';
            card.appendChild(self._mkPanelHeader('Book navigation',
                function () { self._toggleBookMap(); }));

            var tabs = document.createElement('div');
            tabs.className = 'abr-tablist';
            tabs.setAttribute('role', 'tablist');
            tabs.setAttribute('aria-label', 'Navigation sections');
            var defs = [['toc', 'Contents'], ['bookmarks', 'Annotations'], ['search', 'Search'], ['pages', 'Pages'], ['landmarks', 'Landmarks'], ['goto', 'Go to']];
            defs.forEach(function (t) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-tab';
                b.id = 'abr-tab-' + t[0];
                b.setAttribute('role', 'tab');
                b.dataset.tab = t[0];
                b.setAttribute('aria-selected', t[0] === 'toc' ? 'true' : 'false');
                b.setAttribute('aria-controls', 'abr-map-body');
                // Roving tabindex: only the selected tab is in the Tab order
                b.tabIndex = t[0] === 'toc' ? 0 : -1;
                b.textContent = t[1];
                b.addEventListener('click', function () { self._renderBookMapTab(t[0]); });
                // Left/Right (and TV d-pad) move between tabs per ARIA practice
                b.addEventListener('keydown', function (e) {
                    var i = defs.findIndex(function (d) { return d[0] === b.dataset.tab; });
                    var ni = -1;
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ni = (i + 1) % defs.length;
                    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ni = (i - 1 + defs.length) % defs.length;
                    else if (e.key === 'Home') ni = 0;
                    else if (e.key === 'End') ni = defs.length - 1;
                    if (ni >= 0) {
                        e.preventDefault();
                        e.stopPropagation(); // don't let the global arrow handler also fire
                        self._renderBookMapTab(defs[ni][0]);
                        var nb = document.getElementById('abr-tab-' + defs[ni][0]);
                        if (nb) nb.focus();
                    }
                });
                tabs.appendChild(b);
            });
            card.appendChild(tabs);

            var body = document.createElement('div');
            body.id = 'abr-map-body';
            body.className = 'abr-modal-body';
            body.setAttribute('role', 'tabpanel');
            body.setAttribute('aria-labelledby', 'abr-tab-toc');
            body.setAttribute('tabindex', '0');
            card.appendChild(body);
            panel.appendChild(card);
            return panel;
        },

        _renderBookMapTab: function (tab) {
            var self = this;
            self._bookMapTab = tab;
            var body = document.getElementById('abr-map-body');
            if (!body || !self._nav) return;
            document.querySelectorAll('#abr-bookmap .abr-tab').forEach(function (b) {
                var sel = b.dataset.tab === tab;
                b.setAttribute('aria-selected', sel ? 'true' : 'false');
                b.tabIndex = sel ? 0 : -1;
            });
            body.setAttribute('aria-labelledby', 'abr-tab-' + tab);
            body.innerHTML = '';

            function jumpBtn(label, chapter, anchor, level) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-map-item';
                b.textContent = label;
                if (level) b.style.paddingLeft = (12 + level * 18) + 'px';
                if (chapter < 0) { b.disabled = true; }
                else b.addEventListener('click', function () {
                    self._goToTarget(chapter, anchor, true);
                    self._toggleBookMap();
                    // Announce AFTER focus has settled on the toolbar, or the
                    // focus move swallows the live-region update
                    setTimeout(function () {
                        var info = document.getElementById('abr-chapter-info');
                        if (info) info.textContent = 'Jumped to ' + label;
                    }, 150);
                });
                return b;
            }

            function renderTree(nodes, level) {
                nodes.forEach(function (n) {
                    var title = n.Title || n.title || '';
                    var ch = typeof n.Chapter === 'number' ? n.Chapter : n.chapter;
                    var an = n.Anchor || n.anchor || null;
                    if (title) body.appendChild(jumpBtn(title, ch, an, level));
                    var kids = n.Children || n.children || [];
                    if (kids.length) renderTree(kids, level + 1);
                });
            }

            if (tab === 'toc') {
                if (!self._nav.toc.length) {
                    body.textContent = 'This book has no table of contents.';
                } else {
                    if (self._nav.tocGenerated) {
                        var note = document.createElement('p');
                        note.className = 'abr-map-note';
                        note.textContent = 'Generated from the book’s sections — this book has no built-in contents.';
                        body.appendChild(note);
                    }
                    renderTree(self._nav.toc, 0);
                }
            } else if (tab === 'pages') {
                if (!self._nav.pageList.length) body.textContent = 'This book has no print page numbers.';
                else renderTree(self._nav.pageList, 0);
            } else if (tab === 'landmarks') {
                if (!self._nav.landmarks.length) body.textContent = 'This book has no landmarks.';
                else renderTree(self._nav.landmarks, 0);
            } else if (tab === 'bookmarks') {
                self._renderAnnotationsTab(body);
            } else if (tab === 'search') {
                self._renderSearchTab(body);
            } else {
                // Go to: percent ("45%"), print page ("123"), or chapter ("c12")
                var row = document.createElement('div');
                row.className = 'abr-col-row';
                var lab = document.createElement('label');
                lab.setAttribute('for', 'abr-goto-input');
                lab.className = 'abr-col-label';
                lab.textContent = 'Page, percent, or c+chapter';
                var inp = document.createElement('input');
                inp.id = 'abr-goto-input';
                inp.type = 'text';
                inp.className = 'abr-goto-input';
                inp.setAttribute('aria-describedby', 'abr-goto-hint');
                var go = document.createElement('button');
                go.type = 'button';
                go.className = 'abr-col-choice';
                go.textContent = 'Go';
                var hint = document.createElement('span');
                hint.id = 'abr-goto-hint';
                hint.className = 'abr-col-label';
                hint.textContent = 'Examples: 45% · 123 · c12';
                function fail(msg) {
                    hint.textContent = msg;
                    hint.classList.add('abr-contrast-warn');
                    inp.focus();
                }
                function doGo() {
                    var v = (inp.value || '').trim();
                    if (!v) return;
                    var n = self._spine.length;
                    if (v.endsWith('%')) {
                        var pct = parseFloat(v);
                        if (isNaN(pct)) { fail('Enter a percentage like 45%'); return; }
                        var total = Math.max(0, Math.min(1, pct / 100)) * n;
                        var ch = Math.min(n - 1, Math.floor(total));
                        self._navStack.push(self._snapshotLocator());
                        self._updateBackBtn();
                        self._navResetTts(); // Play resumes from the go-to target
                        self._pendingScrollFraction = total - ch;
                        self._loadChapter(ch);
                    } else if (/^c\d+$/i.test(v)) {
                        var ci = parseInt(v.slice(1), 10) - 1;
                        if (ci < 0 || ci >= n) { fail('No chapter ' + v.slice(1) + ' (1–' + n + ')'); return; }
                        self._goToTarget(ci, null, true);
                    } else if (/^\d+$/.test(v) && self._nav.pageList.length) {
                        var hit = self._nav.pageList.find(function (p) {
                            return (p.Title || p.title || '').trim() === v;
                        });
                        if (!hit) { fail('No page "' + v + '" in this book'); return; }
                        self._goToTarget(
                            typeof hit.Chapter === 'number' ? hit.Chapter : hit.chapter,
                            hit.Anchor || hit.anchor || null, true);
                    } else if (/^\d+$/.test(v)) {
                        var pi = parseInt(v, 10) - 1;
                        if (pi < 0 || pi >= n) { fail('No chapter ' + v + ' (1–' + n + ')'); return; }
                        self._goToTarget(pi, null, true);
                    } else {
                        fail('Try a percent (45%), page number, or c+chapter (c12)');
                        return;
                    }
                    self._toggleBookMap();
                }
                go.addEventListener('click', doGo);
                inp.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') { e.preventDefault(); doGo(); }
                });
                row.appendChild(lab);
                row.appendChild(inp);
                row.appendChild(go);
                body.appendChild(row);
                body.appendChild(hint);
            }
        },

        // ── In-book search (Phase 4) ─────────────────────────────────────────

        _renderSearchTab: function (body) {
            var self = this;
            var form = document.createElement('div');
            form.className = 'abr-col-row';

            var lab = document.createElement('label');
            lab.setAttribute('for', 'abr-search-input');
            lab.className = 'abr-col-label';
            lab.textContent = 'Search this book';

            var inp = document.createElement('input');
            inp.id = 'abr-search-input';
            inp.type = 'search';
            inp.className = 'abr-goto-input';
            inp.value = self._searchQuery || '';

            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'abr-col-choice';
            btn.textContent = 'Search';

            form.appendChild(lab);
            form.appendChild(inp);
            form.appendChild(btn);
            body.appendChild(form);

            // Status (live) + results list
            var status = document.createElement('p');
            status.id = 'abr-search-status';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.className = 'abr-col-label';
            body.appendChild(status);

            var list = document.createElement('div');
            list.id = 'abr-search-results';
            list.setAttribute('role', 'list');
            list.setAttribute('aria-label', 'Search results');
            body.appendChild(list);

            function run() {
                var q = (inp.value || '').trim();
                self._searchQuery = q;
                if (q.length < 2) { status.textContent = 'Type at least 2 characters.'; return; }
                status.textContent = 'Searching…';
                list.innerHTML = '';
                // Race guard: only the newest search may render
                var token = (self._searchToken || 0) + 1;
                self._searchToken = token;
                ApiClient.ajax({
                    url: ApiClient.getUrl('A11yBookReader/search/' + self._currentItemId +
                        '?q=' + encodeURIComponent(q)),
                    type: 'GET', dataType: 'json'
                }).then(function (res) {
                    if (token !== self._searchToken) return; // a newer search supersedes
                    var hits = res.Hits || res.hits || [];
                    var total = res.Total != null ? res.Total : (res.total || hits.length);
                    var capped = res.Capped || res.capped;
                    if (!hits.length) {
                        status.textContent = 'No matches for “' + q + '”.';
                        list.setAttribute('aria-label', 'Search results, none');
                        return;
                    }
                    var summary = total + (total === 1 ? ' match' : ' matches') +
                        ' for “' + q + '”' + (capped ? ' (showing first ' + hits.length + ')' : '');
                    status.textContent = summary;
                    list.setAttribute('aria-label', summary);
                    hits.forEach(function (h) {
                        list.appendChild(self._searchResultItem(h));
                    });
                }).catch(function () {
                    if (token !== self._searchToken) return;
                    status.textContent = 'Search failed. Try again.';
                });
            }
            btn.addEventListener('click', run);
            inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); run(); }
            });

            // Re-render prior results when returning to the tab
            if (self._searchQuery && self._searchQuery.length >= 2) {
                setTimeout(run, 0);
            }
        },

        _searchResultItem: function (h) {
            var self = this;
            var chapter = typeof h.Chapter === 'number' ? h.Chapter : h.chapter;
            var title = h.ChapterTitle || h.chapterTitle || ('Section ' + (chapter + 1));
            var before = h.Before || h.before || '';
            var match = h.Match || h.match || '';
            var after = h.After || h.after || '';
            var quote = h.Quote || h.quote || match;
            var ordinal = h.Ordinal != null ? h.Ordinal : (h.ordinal || 0);

            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'abr-search-item';
            item.setAttribute('role', 'listitem');

            var loc = document.createElement('span');
            loc.className = 'abr-search-loc';
            loc.textContent = title;

            var snip = document.createElement('span');
            snip.className = 'abr-search-snip';
            snip.appendChild(document.createTextNode(before));
            var mk = document.createElement('mark');
            mk.textContent = match;
            snip.appendChild(mk);
            snip.appendChild(document.createTextNode(after));

            item.appendChild(loc);
            item.appendChild(snip);
            // Screen-reader label: location + readable snippet
            item.setAttribute('aria-label', 'In ' + title + ': ' + before + match + after);

            item.addEventListener('click', function () {
                self._navStack.push(self._snapshotLocator());
                self._updateBackBtn();
                self._navResetTts(); // Play resumes from the search result
                var term = self._searchQuery;
                if (chapter === self._chapterIndex) {
                    // Resolve immediately; do not arm pending state (would
                    // leak the ordinal into the next cross-chapter jump)
                    var idx = self._findByQuote(
                        document.getElementById('abr-frame').contentDocument, quote, ordinal, term);
                    if (idx !== null) self._goToPara(idx);
                } else {
                    self._pendingAnchor = null;
                    self._pendingQuote = quote;
                    self._pendingQuoteOrdinal = ordinal;
                    self._pendingQuoteTerm = term;
                    self._loadChapter(chapter);
                }
                self._toggleBookMap();
                setTimeout(function () {
                    var info = document.getElementById('abr-chapter-info');
                    if (info) info.textContent = 'Jumped to match in ' + title;
                }, 150);
            });
            return item;
        },

        // ── Footnote popover ─────────────────────────────────────────────────

        _showFootnote: function (chapter, anchor, label) {
            var self = this;
            function render(text) {
                var old = document.getElementById('abr-footnote');
                if (old) old.remove();
                var pop = document.createElement('div');
                pop.id = 'abr-footnote';
                pop.setAttribute('role', 'dialog');
                pop.setAttribute('aria-modal', 'true');
                pop.setAttribute('aria-label', 'Note');
                // Trap Tab inside the popover (only the Return button is
                // focusable, so just keep focus on it)
                pop.addEventListener('keydown', function (e) {
                    if (e.key === 'Tab') { e.preventDefault(); ret.focus(); }
                });
                var content = document.createElement('div');
                content.className = 'abr-footnote-text';
                content.textContent = text || 'Note not found.';
                var ret = document.createElement('button');
                ret.type = 'button';
                ret.className = 'abr-col-choice';
                ret.textContent = 'Return to reading';
                ret.addEventListener('click', function () {
                    pop.remove();
                    var frame = document.getElementById('abr-frame');
                    if (frame) frame.focus();
                });
                pop.appendChild(content);
                pop.appendChild(ret);
                var area = document.getElementById('abr-content-area');
                if (area) area.appendChild(pop);
                self._tvFocusSweep(pop);
                ret.focus();
            }

            try {
                if (chapter === this._chapterIndex) {
                    var doc = document.getElementById('abr-frame').contentDocument;
                    var el = doc.getElementById(anchor);
                    render(el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
                    return;
                }
                ApiClient.ajax({
                    url: ApiClient.getUrl('A11yBookReader/chapter/' + this._currentItemId + '/' + chapter),
                    type: 'GET', dataType: 'text'
                }).then(function (html) {
                    var parsed = new DOMParser().parseFromString(html, 'text/html');
                    var el = parsed.getElementById(anchor);
                    render(el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
                }).catch(function () { render(null); });
            } catch (e) { render(null); }
        },

        // Stepper control: − [value] + with live announce
        _mkStepper: function (label, key, min, max, step, fmt) {
            var self = this;
            var row = document.createElement('div');
            row.className = 'abr-col-row';
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', label);
            var lab = document.createElement('span');
            lab.className = 'abr-col-label';
            lab.textContent = label;
            var out = document.createElement('output');
            out.className = 'abr-col-value';
            // <output> implies role=status/aria-live, but support is patchy
            // (TV browsers, older VoiceOver) — make the announce explicit.
            out.setAttribute('aria-live', 'polite');
            out.textContent = fmt(self._ds[key]);
            function mk(delta, name, icon) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-col-step';
                b.setAttribute('aria-label', name + ' ' + label);
                b.innerHTML = '<span class="material-icons" aria-hidden="true">' + icon + '</span>';
                b.addEventListener('click', function () {
                    var v = Math.max(min, Math.min(max, self._ds[key] + delta));
                    if (v === self._ds[key]) return;
                    self._ds[key] = v;
                    out.textContent = fmt(v);
                    self._applyDisplaySettings();
                });
                return b;
            }
            row.appendChild(lab);
            row.appendChild(mk(-step, 'Decrease', 'remove'));
            row.appendChild(out);
            row.appendChild(mk(step, 'Increase', 'add'));
            return row;
        },

        // Radio-style row of choices (font, theme, alignment)
        _mkChoices: function (label, key, options, onChange) {
            var self = this;
            var row = document.createElement('div');
            row.className = 'abr-col-row';
            row.setAttribute('role', 'radiogroup');
            row.setAttribute('aria-label', label);
            var lab = document.createElement('span');
            lab.className = 'abr-col-label';
            lab.textContent = label;
            row.appendChild(lab);
            options.forEach(function (opt) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-col-choice';
                b.setAttribute('role', 'radio');
                b.setAttribute('aria-checked', self._ds[key] === opt.value ? 'true' : 'false');
                b.dataset.value = opt.value;
                b.textContent = opt.label;
                if (opt.style) b.setAttribute('style', opt.style);
                b.addEventListener('click', function () {
                    self._ds[key] = opt.value;
                    row.querySelectorAll('[role="radio"]').forEach(function (r) {
                        r.setAttribute('aria-checked', r.dataset.value === opt.value ? 'true' : 'false');
                    });
                    if (onChange) onChange(opt.value);
                    self._applyDisplaySettings();
                });
                row.appendChild(b);
            });
            return this._wireRadiogroup(row);
        },

        // APG radio-group keyboard pattern, shared by every radiogroup row
        // (_mkChoices, _mkViewModeChoice, _mkThemeSwatches): roving tabindex —
        // the checked (or first) radio is the group's single Tab stop — and
        // arrows that move AND select, delegating to each radio's own click
        // handler so the real selection logic isn't duplicated here.
        _wireRadiogroup: function (row) {
            function radios() {
                return Array.prototype.slice.call(row.querySelectorAll('[role="radio"]'));
            }
            function rove() {
                var rs = radios();
                var on = rs.findIndex(function (r) { return r.getAttribute('aria-checked') === 'true'; });
                if (on < 0) on = 0;
                rs.forEach(function (r, i) { r.tabIndex = i === on ? 0 : -1; });
            }
            rove();
            row.addEventListener('keydown', function (e) {
                var rs = radios();
                var i = rs.indexOf(document.activeElement);
                if (i < 0) return;
                var n = -1;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % rs.length;
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + rs.length) % rs.length;
                else if (e.key === 'Home') n = 0;
                else if (e.key === 'End') n = rs.length - 1;
                if (n < 0) return;
                e.preventDefault();
                e.stopPropagation(); // don't let the global arrow handler also fire
                rs[n].click();       // arrows select (APG): click owns aria-checked
                rove();              // re-park the Tab stop on the new selection
                rs[n].focus();
            });
            return row;
        },

        // A panel header with a title and a Done button — gives touch users a
        // visible way to dismiss popups (keyboard/TV use Escape).
        // Close every popup panel except the one named — only one open at a time
        _closeOtherPanels: function (keep) {
            if (keep !== 'bookmap') {
                var m = document.getElementById('abr-bookmap');
                if (m && !m.hasAttribute('hidden')) {
                    m.setAttribute('hidden', '');
                    var mb = document.getElementById('abr-bookmap-btn');
                    if (mb) mb.setAttribute('aria-expanded', 'false');
                }
            }
            if (keep !== 'settings') {
                var s = document.getElementById('abr-settings');
                if (s && !s.hasAttribute('hidden')) {
                    s.setAttribute('hidden', '');
                    var sb = document.getElementById('abr-settings-btn');
                    if (sb) sb.setAttribute('aria-expanded', 'false');
                }
            }
        },

        _mkPanelHeader: function (title, closeFn) {
            var header = document.createElement('div');
            header.className = 'abr-panel-header';
            var h = document.createElement('span');
            h.className = 'abr-panel-title';
            h.textContent = title;
            var done = document.createElement('button');
            done.type = 'button';
            done.className = 'abr-panel-close';
            done.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';
            done.setAttribute('aria-label', 'Close ' + title);
            done.addEventListener('click', closeFn);
            header.appendChild(h);
            header.appendChild(done);
            return header;
        },

        // ── Settings modal (Bookshare-style tabbed dialog) ───────────────────
        // Single modal for all reader preferences — display, audio, and motion —
        // organized into Text / Page / Audio / Color tabs. Reuses _mkChoices /
        // _mkStepper and the voice/speed handlers.
        _buildSettingsModal: function () {
            var self = this;
            var modal = document.createElement('div');
            modal.id = 'abr-settings';
            modal.className = 'abr-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-label', 'Settings');
            modal.setAttribute('hidden', '');

            var card = document.createElement('div');
            card.className = 'abr-modal-card';
            card.appendChild(self._mkPanelHeader('Settings', function () { self._closeSettingsModal(); }));

            var TABS = [{ id: 'text', label: 'Text' }, { id: 'page', label: 'Page' },
                        { id: 'audio', label: 'Audio' }, { id: 'color', label: 'Color' }];
            var tablist = document.createElement('div');
            tablist.className = 'abr-tablist';
            tablist.setAttribute('role', 'tablist');
            tablist.setAttribute('aria-label', 'Settings sections');
            TABS.forEach(function (t, i) {
                var tab = document.createElement('button');
                tab.type = 'button';
                tab.className = 'abr-tab';
                tab.id = 'abr-tab-' + t.id;
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-controls', 'abr-tabpanel-' + t.id);
                tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
                tab.tabIndex = i === 0 ? 0 : -1;
                tab.textContent = t.label;
                tab.addEventListener('click', function () { self._settingsTab(t.id); });
                // Full APG tablist keys, same as the Book-Map tablist: arrows
                // (both axes, for TV d-pad too) plus Home/End.
                tab.addEventListener('keydown', function (e) {
                    var n = -1;
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % TABS.length;
                    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + TABS.length) % TABS.length;
                    else if (e.key === 'Home') n = 0;
                    else if (e.key === 'End') n = TABS.length - 1;
                    if (n < 0) return;
                    e.preventDefault();
                    e.stopPropagation(); // don't let the global arrow handler also fire
                    self._settingsTab(TABS[n].id);
                    var nt = document.getElementById('abr-tab-' + TABS[n].id);
                    if (nt) nt.focus();
                });
                tablist.appendChild(tab);
            });
            card.appendChild(tablist);

            var body = document.createElement('div');
            body.className = 'abr-modal-body';
            var panels = {};
            TABS.forEach(function (t, i) {
                var p = document.createElement('div');
                p.id = 'abr-tabpanel-' + t.id;
                p.className = 'abr-tabpanel';
                p.setAttribute('role', 'tabpanel');
                p.setAttribute('aria-labelledby', 'abr-tab-' + t.id);
                if (i !== 0) p.setAttribute('hidden', '');
                panels[t.id] = p;
                body.appendChild(p);
            });
            card.appendChild(body);

            // Text
            panels.text.appendChild(self._mkChoices('Font', 'FontFamily', [
                { value: 'publisher', label: 'Book' },
                { value: 'serif', label: 'Serif', style: 'font-family:Georgia,serif' },
                { value: 'sans', label: 'Sans', style: 'font-family:system-ui,sans-serif' },
                { value: 'opendyslexic', label: 'OpenDyslexic' }
            ]));
            panels.text.appendChild(self._mkStepper('Text size', 'FontSizePct', 70, 250, 10, function (v) { return v + '%'; }));
            panels.text.appendChild(self._mkStepper('Line spacing', 'LineHeightPct', 100, 250, 10, function (v) { return (v / 100).toFixed(1); }));
            panels.text.appendChild(self._mkStepper('Letter spacing', 'LetterSpacing', 0, 25, 1, function (v) { return (v / 100).toFixed(2) + 'em'; }));
            panels.text.appendChild(self._mkStepper('Word spacing', 'WordSpacing', 0, 50, 5, function (v) { return (v / 100).toFixed(2) + 'em'; }));
            panels.text.appendChild(self._mkStepper('Paragraph spacing', 'ParaSpacingPct', 100, 300, 25, function (v) { return v + '%'; }));
            panels.text.appendChild(self._mkChoices('Alignment', 'Align', [
                { value: 'left', label: 'Left' }, { value: 'justify', label: 'Justified' }
            ]));

            // Page
            panels.page.appendChild(self._mkViewModeChoice());
            panels.page.appendChild(self._mkStepper('Margins', 'MarginPct', 2, 20, 2, function (v) { return v + '%'; }));
            panels.page.appendChild(self._mkToggle('Reading ruler', 'Ruler', function (on) {
                self._rulerOn = on;
                var ruler = document.getElementById('abr-ruler');
                if (ruler) ruler.toggleAttribute('hidden', !on);
            }));
            panels.page.appendChild(self._mkToggle('Reduce motion', 'ReducedMotion', function (on) {
                self._reducedMotion = on; self._applyDisplaySettings();
            }));

            // Audio
            self._buildAudioControls(panels.audio);

            // Color
            panels.color.appendChild(self._mkThemeSwatches());
            panels.color.appendChild(self._mkColorRows());

            var footer = document.createElement('div');
            footer.className = 'abr-modal-footer';
            var reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'abr-col-choice';
            reset.textContent = 'Reset to defaults';
            reset.addEventListener('click', function () { self._resetSettings(); });
            footer.appendChild(reset);
            card.appendChild(footer);

            modal.appendChild(card);
            modal.addEventListener('click', function (e) { if (e.target === modal) self._closeSettingsModal(); });
            return modal;
        },

        _settingsTab: function (id) {
            ['text', 'page', 'audio', 'color'].forEach(function (t) {
                var tab = document.getElementById('abr-tab-' + t);
                var panel = document.getElementById('abr-tabpanel-' + t);
                var on = t === id;
                if (tab) { tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on ? 0 : -1; }
                if (panel) panel.toggleAttribute('hidden', !on);
            });
        },

        _openSettingsModal: function () {
            var m = document.getElementById('abr-settings');
            if (!m) return;
            this._closeOtherPanels && this._closeOtherPanels('settings');
            m.removeAttribute('hidden');
            var btn = document.getElementById('abr-settings-btn');
            if (btn) btn.setAttribute('aria-expanded', 'true');
            var first = document.getElementById('abr-tab-text');
            if (first) first.focus();
        },

        _closeSettingsModal: function () {
            var m = document.getElementById('abr-settings');
            if (m) m.setAttribute('hidden', '');
            var btn = document.getElementById('abr-settings-btn');
            if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
        },

        // View-mode radio group for the Page tab. Uses _setViewMode (the real
        // switch), not _mkChoices (which only writes a display setting).
        _mkViewModeChoice: function () {
            var self = this;
            var row = document.createElement('div');
            row.id = 'abr-viewmode-choice';
            row.className = 'abr-col-row';
            row.setAttribute('role', 'radiogroup');
            row.setAttribute('aria-label', 'View mode');
            var lab = document.createElement('span');
            lab.className = 'abr-col-label';
            lab.textContent = 'View';
            row.appendChild(lab);
            [['page', 'Page'], ['chapter', 'Chapter'], ['scroll', 'Scroll']].forEach(function (o) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-col-choice';
                b.setAttribute('role', 'radio');
                b.dataset.value = o[0];
                b.setAttribute('aria-checked', self._viewMode === o[0] ? 'true' : 'false');
                b.textContent = o[1];
                b.addEventListener('click', function () { self._setViewMode(o[0]); });
                row.appendChild(b);
            });
            return this._wireRadiogroup(row);
        },

        _mkToggle: function (label, key, onChange) {
            var self = this;
            var row = document.createElement('div');
            row.className = 'abr-col-row';
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'abr-col-choice';
            b.setAttribute('aria-pressed', self._ds[key] ? 'true' : 'false');
            b.textContent = label;
            b.addEventListener('click', function () {
                self._ds[key] = !self._ds[key];
                b.setAttribute('aria-pressed', self._ds[key] ? 'true' : 'false');
                if (onChange) onChange(self._ds[key]);
                self._saveDisplaySettings();
            });
            row.appendChild(b);
            return row;
        },

        // Theme presets as preview swatches (sample text in each palette).
        _mkThemeSwatches: function () {
            var self = this;
            var row = document.createElement('div');
            row.className = 'abr-col-row abr-swatch-row';
            row.setAttribute('role', 'radiogroup');
            row.setAttribute('aria-label', 'Color theme');
            var presets = [['light', 'Light'], ['dark', 'Dark'], ['sepia', 'Sepia'],
                           ['contrast', 'High contrast'], ['custom', 'Custom']];
            presets.forEach(function (p) {
                var th = self._themes[p[0]];
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-swatch';
                b.dataset.value = p[0];
                b.setAttribute('role', 'radio');
                b.setAttribute('aria-checked', self._ds.Theme === p[0] ? 'true' : 'false');
                b.setAttribute('aria-label', p[1]);
                if (th) {
                    b.style.background = th.bg; b.style.color = th.fg;
                    b.innerHTML = '<span class="abr-swatch-sample" aria-hidden="true">Aa</span>' +
                                  '<span class="abr-swatch-name">' + p[1] + '</span>';
                } else { b.textContent = p[1]; } // custom
                b.addEventListener('click', function () {
                    self._ds.Theme = p[0];
                    row.querySelectorAll('[role="radio"]').forEach(function (r) {
                        r.setAttribute('aria-checked', r.dataset.value === p[0] ? 'true' : 'false');
                    });
                    self._syncCustomRow();
                    self._applyDisplaySettings();
                });
                row.appendChild(b);
            });
            return this._wireRadiogroup(row);
        },

        // Custom fg/bg (with live contrast) + read-aloud highlight colors.
        _mkColorRows: function () {
            var self = this;
            var frag = document.createDocumentFragment();
            function colorInput(label, key) {
                var wrap = document.createElement('label');
                wrap.className = 'abr-col-color';
                var txt = document.createElement('span');
                txt.textContent = label;
                var inp = document.createElement('input');
                inp.type = 'color';
                inp.value = self._ds[key] || '#000000';
                inp.setAttribute('aria-label', label);
                inp.addEventListener('input', function () {
                    self._ds[key] = inp.value;
                    self._updateContrastReadout();
                    self._applyDisplaySettings();
                });
                wrap.appendChild(txt); wrap.appendChild(inp);
                return wrap;
            }
            var custom = document.createElement('div');
            custom.id = 'abr-col-custom';
            custom.className = 'abr-col-row';
            custom.setAttribute('role', 'group');
            custom.setAttribute('aria-label', 'Custom colors');
            custom.appendChild(colorInput('Text color', 'CustomFg'));
            custom.appendChild(colorInput('Background color', 'CustomBg'));
            var ratio = document.createElement('span');
            ratio.id = 'abr-contrast-readout';
            ratio.setAttribute('role', 'status');
            ratio.setAttribute('aria-live', 'polite');
            custom.appendChild(ratio);
            frag.appendChild(custom);

            var hl = document.createElement('div');
            hl.className = 'abr-col-row';
            hl.setAttribute('role', 'group');
            hl.setAttribute('aria-label', 'Read-aloud highlight colors');
            var hlLab = document.createElement('span');
            hlLab.className = 'abr-col-label';
            hlLab.textContent = 'Read-aloud highlight';
            hl.appendChild(hlLab);
            hl.appendChild(colorInput('Highlighted text', 'HlFg'));
            hl.appendChild(colorInput('Highlight background', 'HlBg'));
            frag.appendChild(hl);
            setTimeout(function () { self._syncCustomRow(); }, 0);
            return frag;
        },

        // Voice + speed controls for the Audio tab (canonical home; the old
        // toolbar TTS-settings panel is removed in the redesign).
        _buildAudioControls: function (container) {
            var self = this;
            var speedGroup = document.createElement('div');
            speedGroup.className = 'abr-settings-group';
            var speedLabel = document.createElement('label');
            speedLabel.setAttribute('for', 'abr-speed-select');
            speedLabel.className = 'abr-settings-label';
            speedLabel.textContent = 'Speed';
            var speedSelect = document.createElement('select');
            speedSelect.id = 'abr-speed-select';
            speedSelect.className = 'abr-speed-select';
            speedSelect.setAttribute('aria-label', 'Reading speed');
            [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0].forEach(function (r) {
                var opt = document.createElement('option');
                opt.value = String(r); opt.textContent = r + '×';
                if (r === self._ttsRate) opt.selected = true;
                speedSelect.appendChild(opt);
            });
            speedSelect.addEventListener('change', function () {
                self._ttsRate = parseFloat(speedSelect.value);
                if (self._ds) { self._ds.TtsRatePct = Math.round(self._ttsRate * 100); self._saveDisplaySettings(); }
                if (self._ttsPlaying && !self._ttsPaused) {
                    if (self._piperAudio) {
                        if (self._piperLastAbs != null) self._ttsCharOffset = self._piperLastAbs;
                        self._stopPiperTts(); self._ttsPlaying = false; self._startTts();
                    } else if (self._isTvVoice()) {
                        self._stopTvTts(); self._ttsPlaying = false; self._startTts();
                    } else if (typeof window.speechSynthesis !== 'undefined') {
                        self._ttsCharOffset += self._ttsLastBoundary; self._ttsLastBoundary = 0;
                        window.speechSynthesis.cancel(); self._ttsPlaying = false;
                        self._ttsUtterance = null; self._startTts();
                    }
                }
            });
            speedGroup.appendChild(speedLabel); speedGroup.appendChild(speedSelect);

            var voiceGroup = document.createElement('div');
            voiceGroup.className = 'abr-settings-group';
            var voiceLabel = document.createElement('label');
            voiceLabel.setAttribute('for', 'abr-voice-select');
            voiceLabel.className = 'abr-settings-label';
            voiceLabel.textContent = 'Voice';
            var voiceSelect = document.createElement('select');
            voiceSelect.id = 'abr-voice-select';
            voiceSelect.className = 'abr-voice-select';
            voiceSelect.addEventListener('change', function () {
                self._ttsVoiceURI = voiceSelect.value;
                self._saveSettings();
                if (!self._ttsPlaying && !self._ttsPaused) return;
                if (self._piperAudio) {
                    if (self._piperLastAbs != null) self._ttsCharOffset = self._piperLastAbs;
                } else if (self._hlTicker && self._hlTickLast != null) {
                    self._ttsCharOffset = self._hlTickLast;
                } else {
                    self._ttsCharOffset += self._ttsLastBoundary;
                }
                self._ttsLastBoundary = 0;
                self._stopHlTicker(); self._stopPiperTts(); self._stopTvTts();
                if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
                self._ttsUtterance = null;
                if (self._ttsPlaying && !self._ttsPaused) { self._ttsPlaying = false; self._startTts(); }
            });
            voiceGroup.appendChild(voiceLabel); voiceGroup.appendChild(voiceSelect);

            container.appendChild(speedGroup);
            container.appendChild(voiceGroup);
        },

        _resetSettings: function () {
            var d = this._dsDefaults;
            for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) this._ds[k] = d[k];
            this._saveDisplaySettings();
            this._applyDisplaySettings();
            // Rebuild the modal so every control reflects the reset values
            var old = document.getElementById('abr-settings');
            if (old && old.parentNode) {
                var fresh = this._buildSettingsModal();
                old.parentNode.replaceChild(fresh, old);
                fresh.removeAttribute('hidden');
                this._populateVoices();
                var t = document.getElementById('abr-tab-text');
                if (t) t.focus();
            }
        },

        _syncCustomRow: function () {
            var row = document.getElementById('abr-col-custom');
            if (!row) return;
            if (this._ds.Theme === 'custom') row.removeAttribute('hidden');
            else row.setAttribute('hidden', '');
            this._updateContrastReadout();
        },

        _updateContrastReadout: function () {
            var el = document.getElementById('abr-contrast-readout');
            if (!el) return;
            var r = this._contrastRatio(this._ds.CustomFg, this._ds.CustomBg);
            if (r === null) { el.textContent = ''; return; }
            var txt = 'Contrast ' + r.toFixed(1) + ':1';
            if (r < 4.5) {
                txt = '\u26a0 ' + txt + ' — below the 4.5:1 minimum for comfortable reading';
                el.classList.add('abr-contrast-warn');
            } else {
                el.classList.remove('abr-contrast-warn');
            }
            el.textContent = txt;
        },

        // ── Theme & Typography Engine ────────────────────────────────────────

        _themes: {
            light:    { bg: '#fafaf7', fg: '#1a1a1a', link: '#0a5da8' },
            dark:     { bg: '#121212', fg: '#e8e8e6', link: '#6cb2e8' },
            sepia:    { bg: '#f4ecd8', fg: '#5b4636', link: '#7a4e2d' },
            contrast: { bg: '#000000', fg: '#ffffff', link: '#ffff00' }
        },

        _activeColors: function () {
            var ds = this._ds || this._dsDefaults;
            if (ds.Theme === 'custom') {
                return { bg: ds.CustomBg || '#fafaf7', fg: ds.CustomFg || '#1a1a1a', link: ds.CustomFg || '#0a5da8' };
            }
            return this._themes[ds.Theme] || this._themes.light;
        },

        // WCAG relative luminance + contrast ratio
        _contrastRatio: function (hex1, hex2) {
            function lum(hex) {
                var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
                if (!m) return null;
                var n = parseInt(m[1], 16);
                var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
                    v /= 255;
                    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                });
                return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            }
            var l1 = lum(hex1), l2 = lum(hex2);
            if (l1 === null || l2 === null) return null;
            var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
            return (hi + 0.05) / (lo + 0.05);
        },

        _fontStack: function () {
            switch ((this._ds || this._dsDefaults).FontFamily) {
                case 'serif': return 'Georgia, "Times New Roman", serif';
                case 'sans': return 'system-ui, "Segoe UI", Roboto, Arial, sans-serif';
                case 'opendyslexic': return '"OpenDyslexic", system-ui, sans-serif';
                default: return null; // publisher: no override
            }
        },

        // CSS injected into the chapter document for typography + theme
        _readingCss: function () {
            var ds = this._ds || this._dsDefaults;
            var col = this._activeColors();
            var css =
                '@font-face{font-family:"OpenDyslexic";src:url("/A11yBookReader/font/OpenDyslexic-Regular.woff2") format("woff2");font-weight:normal;font-style:normal;font-display:swap;}' +
                '@font-face{font-family:"OpenDyslexic";src:url("/A11yBookReader/font/OpenDyslexic-Bold.woff2") format("woff2");font-weight:bold;font-style:normal;font-display:swap;}' +
                '@font-face{font-family:"OpenDyslexic";src:url("/A11yBookReader/font/OpenDyslexic-Italic.woff2") format("woff2");font-weight:normal;font-style:italic;font-display:swap;}' +
                'html{background:' + col.bg + ' !important;}' +
                'body{background:' + col.bg + ' !important;color:' + col.fg + ' !important;' +
                'font-size:' + ds.FontSizePct + '% !important;}' +
                'body *:not(#abr-hl-box){background-color:transparent !important;}' +
                'body *{color:' + col.fg + ' !important;' +
                'line-height:' + (ds.LineHeightPct / 100) + ' !important;' +
                'letter-spacing:' + (ds.LetterSpacing / 100) + 'em !important;' +
                'word-spacing:' + (ds.WordSpacing / 100) + 'em !important;' +
                'text-align:' + (ds.Align === 'justify' ? 'justify' : 'left') + ' !important;}' +
                'a, a *{color:' + col.link + ' !important;text-decoration:underline;}' +
                'p{margin-top:' + (0.6 * ds.ParaSpacingPct / 100) + 'em !important;' +
                'margin-bottom:' + (0.6 * ds.ParaSpacingPct / 100) + 'em !important;}';
            var stack = this._fontStack();
            if (stack) css += 'body, body *{font-family:' + stack + ' !important;}';
            return css;
        },

        // Theme variables for the reader chrome (bars derive from the page)
        _applyChromeTheme: function () {
            var overlay = document.getElementById('abr-overlay');
            if (!overlay) return;
            var col = this._activeColors();
            overlay.style.setProperty('--abr-page-bg', col.bg);
            overlay.style.setProperty('--abr-page-fg', col.fg);
            overlay.classList.add('abr-themed');
            // In-app reduced-motion kills CSS transitions too, not just JS motion
            overlay.classList.toggle('abr-reduce', !!this._reducedMotion);
        },

        // Re-apply everything after a settings change, holding the position
        _applyDisplaySettings: function () {
            this._reducedMotion = this._ds.ReducedMotion ||
                !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            this._applyChromeTheme();
            var frame = document.getElementById('abr-frame');
            if (!frame) return;
            var keep = this._firstVisiblePara();
            this._setupChapterView(frame);
            if (keep !== null) this._goToPara(keep);
            this._saveDisplaySettings();
        },

        // ── API Helpers ──────────────────────────────────────────────────────

        _fetchSpine: function (itemId) {
            return ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/spine/' + itemId),
                type: 'GET',
                dataType: 'json'
            });
        },

        // ── Reading Progress ─────────────────────────────────────────────────

        _fetchProgress: function (itemId) {
            return ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/progress/' + itemId),
                type: 'GET',
                dataType: 'json'
            }).catch(function () { return null; }); // 404 = no progress yet
        },

        // Save a Readium-style locator: structural fragment (Position), text
        // quote context, and progressions — so any future renderer or format
        // can resolve the spot.
        _saveProgress: function (chapter, fraction, para) {
            if (!this._currentItemId) return;
            // When TTS is reading (or paused mid-read), the position that
            // matters is the SPOKEN paragraph, not the visual viewport top.
            var spoken = this._currentTtsBlock();
            if (spoken !== null && typeof para === 'number') para = spoken;
            // Position already computed here — keep the bookmark toggle's
            // pressed state in sync at no extra layout cost
            this._updateBookmarkBtn(chapter, fraction, para);
            var spineLen = Math.max(1, this._spine.length);
            var item = this._spine[chapter] || {};
            var text = null;
            if (typeof para === 'number' && para >= 0) {
                try {
                    var doc = document.getElementById('abr-frame').contentDocument;
                    var blocks = this._getBlocks(doc);
                    var grab = function (el, n, fromEnd) {
                        var t = (el && el.textContent || '').replace(/\s+/g, ' ').trim();
                        return fromEnd ? t.slice(-n) : t.slice(0, n);
                    };
                    if (blocks[para]) {
                        text = {
                            Before: para > 0 ? grab(blocks[para - 1], 40, true) : null,
                            Highlight: grab(blocks[para], 80, false),
                            After: para + 1 < blocks.length ? grab(blocks[para + 1], 40, false) : null
                        };
                    }
                } catch (e) {}
            }
            try {
                ApiClient.ajax({
                    url: ApiClient.getUrl('A11yBookReader/progress/' + this._currentItemId),
                    type: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({
                        Href: item.Href || item.href || null,
                        Locations: {
                            Chapter: chapter,
                            Progression: fraction,
                            TotalProgression: (chapter + fraction) / spineLen,
                            Position: (typeof para === 'number' && para >= 0) ? para : null
                        },
                        Text: text
                    })
                }).catch(function () {});
            } catch (e) {}
        },

        // ── Annotations & bookmarks (Phase 6) ────────────────────────────────
        // Stored server-side per user per book as W3C-Web-Annotation-shaped
        // records whose target is the same Readium locator used for progress.

        _loadAnnotations: function (itemId) {
            var self = this;
            self._annotations = [];
            ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/annotations/' + itemId),
                type: 'GET',
                dataType: 'json'
            }).then(function (list) {
                self._annotations = (list || []).map(self._normalizeAnnotation);
                self._updateBookmarkBtn();
                var fr = document.getElementById('abr-frame');
                if (fr) self._paintAnnotations(fr);
            }).catch(function () {});
        },

        // Defensive about JSON casing, same as the locator load
        _normalizeAnnotation: function (a) {
            var t = a.Target || a.target || {};
            var loc = t.Locations || t.locations || {};
            var txt = t.Text || t.text || null;
            return {
                id: a.Id || a.id,
                type: a.Type || a.type || 'bookmark',
                body: a.Body != null ? a.Body : (a.body != null ? a.body : null),
                color: a.Color || a.color || null,
                href: t.Href || t.href || null,
                chapter: typeof loc.Chapter === 'number' ? loc.Chapter : (loc.chapter || 0),
                fraction: typeof loc.Progression === 'number' ? loc.Progression : (loc.progression || 0),
                para: (loc.Position != null) ? loc.Position : (loc.position != null ? loc.position : null),
                quote: txt ? (txt.Highlight || txt.highlight || null) : null,
                before: txt ? (txt.Before || txt.before || null) : null,
                after: txt ? (txt.After || txt.after || null) : null
            };
        },

        _bookmarks: function () {
            return (this._annotations || [])
                .filter(function (a) { return a.type === 'bookmark'; })
                .sort(function (x, y) { return (x.chapter - y.chapter) || (x.fraction - y.fraction); });
        },

        // A bookmark "at" the current position: same chapter and same paragraph
        // when both sides know it, else within 2% of the chapter. Optional args
        // let already-computed values be reused (avoids extra layout passes).
        _findBookmarkAt: function (ch, fr, pa) {
            if (ch === undefined) ch = this._chapterIndex;
            if (fr === undefined) fr = this._currentScrollFraction();
            if (pa === undefined) pa = this._firstVisiblePara();
            var list = this._bookmarks();
            for (var i = 0; i < list.length; i++) {
                var b = list[i];
                if (b.chapter !== ch) continue;
                if (b.para != null && pa != null) { if (b.para === pa) return b; }
                else if (Math.abs(b.fraction - fr) <= 0.02) return b;
            }
            return null;
        },

        _updateBookmarkBtn: function (ch, fr, pa) {
            var btn = document.getElementById('abr-bookmark-btn');
            if (!btn) return;
            var on = !!this._findBookmarkAt(ch, fr, pa);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            var icon = btn.querySelector('.material-icons');
            if (icon) icon.textContent = on ? 'bookmark' : 'bookmark_border';
        },

        _toggleBookmark: function () {
            var self = this;
            if (!self._currentItemId || !self._spine) return;
            var info = document.getElementById('abr-chapter-info');
            var existing = self._findBookmarkAt();
            if (existing) { self._deleteAnnotation(existing, null); return; }

            var ch = self._chapterIndex;
            var fr = self._currentScrollFraction();
            var pa = self._firstVisiblePara();
            // Quote context makes the bookmark robust to re-rendering and
            // readable in the Bookmarks list
            var text = null;
            try {
                var doc = document.getElementById('abr-frame').contentDocument;
                var blocks = self._getBlocks(doc);
                var el = (typeof pa === 'number' && pa >= 0) ? blocks[pa] : null;
                var snippet = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
                if (snippet) text = { Highlight: snippet };
            } catch (e) {}
            var item = self._spine[ch] || {};
            ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/annotations/' + self._currentItemId),
                type: 'POST',
                contentType: 'application/json',
                dataType: 'json',
                data: JSON.stringify({
                    Type: 'bookmark',
                    Href: item.Href || item.href || null,
                    Locations: {
                        Chapter: ch,
                        Progression: fr,
                        TotalProgression: (ch + fr) / Math.max(1, self._spine.length),
                        Position: (typeof pa === 'number' && pa >= 0) ? pa : null
                    },
                    Text: text
                })
            }).then(function (created) {
                self._annotations.push(self._normalizeAnnotation(created));
                self._updateBookmarkBtn();
                self._renderBookmarksIfOpen();
                if (info) info.textContent = 'Bookmark added';
            }).catch(function () {
                if (info) info.textContent = 'Could not add bookmark';
            });
        },

        _deleteAnnotation: function (a, row) {
            var self = this;
            ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/annotations/' + self._currentItemId + '/' + a.id),
                type: 'DELETE'
            }).then(function () {
                self._annotations = (self._annotations || []).filter(function (x) { return x.id !== a.id; });
                self._updateBookmarkBtn();
                var fr = document.getElementById('abr-frame');
                if (fr) self._paintAnnotations(fr);
                if (row && row.parentNode) {
                    var body = document.getElementById('abr-map-body');
                    self._renderBookmarksIfOpen();
                    // The focused delete button just vanished — land focus on the
                    // tabpanel so keyboard/SR users aren't dropped to <body>
                    if (body) body.focus();
                }
                var info = document.getElementById('abr-chapter-info');
                if (info) info.textContent = (a.type || 'bookmark') + ' removed';
            }).catch(function () {
                var info = document.getElementById('abr-chapter-info');
                if (info) info.textContent = 'Could not remove ' + (a.type || 'bookmark');
            });
        },

        // Rotor unit "Bookmark": jump to the nearest bookmark in delta's
        // direction, ordered by (chapter, progression within chapter).
        _navByBookmark: function (delta) {
            var info = document.getElementById('abr-chapter-info');
            var list = this._bookmarks();
            if (!list.length) { if (info) info.textContent = 'No bookmarks in this book'; return; }
            var ch = this._chapterIndex, fr = this._currentScrollFraction();
            var target = null, idx = -1;
            if (delta > 0) {
                for (var i = 0; i < list.length; i++) {
                    if (list[i].chapter > ch || (list[i].chapter === ch && list[i].fraction > fr + 0.005)) { target = list[i]; idx = i; break; }
                }
            } else {
                for (var j = list.length - 1; j >= 0; j--) {
                    if (list[j].chapter < ch || (list[j].chapter === ch && list[j].fraction < fr - 0.005)) { target = list[j]; idx = j; break; }
                }
            }
            if (!target) {
                if (info) info.textContent = delta > 0 ? 'No bookmarks after this position' : 'No bookmarks before this position';
                return;
            }
            this._goToLocator(target);
            var announce = 'Bookmark ' + (idx + 1) + ' of ' + list.length;
            setTimeout(function () {
                var inf = document.getElementById('abr-chapter-info');
                if (inf) inf.textContent = announce;
            }, 150);
        },

        // Jump to a stored locator — same restore mechanics as _goBack
        _goToLocator: function (loc) {
            this._navResetTts();
            if (this._viewMode === 'scroll') {
                this._chapterIndex = loc.chapter;
                this._scrollGoToAnchor(loc.chapter, null);
                if (loc.para != null) {
                    var selfRef = this;
                    setTimeout(function () { selfRef._scrollGoToPara(loc.chapter, loc.para); }, 120);
                }
                return;
            }
            if (loc.chapter === this._chapterIndex) {
                if (!this._goToPara(loc.para)) {
                    if (this._viewMode === 'page') {
                        this._goToPage(Math.round(loc.fraction * (this._pageCount - 1)), true);
                    }
                }
                return;
            }
            this._pendingScrollFraction = loc.fraction;
            this._pendingPara = loc.para;
            this._loadChapter(loc.chapter);
        },

        _renderBookmarksIfOpen: function () {
            var panel = document.getElementById('abr-bookmap');
            if (panel && !panel.hasAttribute('hidden') && this._bookMapTab === 'bookmarks') {
                this._renderBookMapTab('bookmarks');
            }
        },

        // ── Highlights & notes (Phase 6 part 2) ──────────────────────────────
        // Select text → popover (Highlight / Add note, or H / N). Anchored with
        // a TextQuoteSelector (exact + prefix/suffix sliced from the block's
        // raw textContent, so re-anchoring is a plain indexOf) plus the block
        // index as the position selector. Painted with the CSS Custom Highlight
        // API: ranges live-track layout, so there is no repaint-on-resize work.
        // Browsers without the API just don't paint; the list still works.

        _annColors: { yellow: '#ffe08a', green: '#b5e8a3', blue: '#aecbfa', pink: '#f8b8c8', orange: '#ffc28a' },

        // Char offsets of a Range within a block, via a text-node walk. The end
        // clamps to the block: a selection spanning paragraphs highlights its
        // first paragraph's part.
        _blockOffsets: function (block, range) {
            var start = -1, end = -1, pos = 0;
            var walker = block.ownerDocument.createTreeWalker(block, 4 /* TEXT */);
            var n;
            while ((n = walker.nextNode())) {
                if (n === range.startContainer) start = pos + range.startOffset;
                if (n === range.endContainer) { end = pos + range.endOffset; break; }
                pos += n.textContent.length;
            }
            if (start < 0) return null;
            if (end < 0) end = block.textContent.length;
            return { start: start, end: Math.min(end, block.textContent.length) };
        },

        // Map block-relative char offsets back to a DOM Range.
        _rangeFromBlock: function (doc, block, start, end) {
            var range = doc.createRange();
            var pos = 0, gotStart = false;
            var walker = doc.createTreeWalker(block, 4 /* TEXT */);
            var n;
            while ((n = walker.nextNode())) {
                var len = n.textContent.length;
                if (!gotStart && start < pos + len) { range.setStart(n, start - pos); gotStart = true; }
                if (gotStart && end <= pos + len) { range.setEnd(n, end - pos); return range; }
                pos += len;
            }
            return null;
        },

        // Blocks + chapter for an element, view-mode aware (scroll mode scopes
        // to the containing section; Position stays chapter-relative).
        _blocksForEl: function (doc, el) {
            if (this._viewMode === 'scroll') {
                var sec = el.closest && el.closest('section.abr-ch');
                if (!sec) return null;
                return { chapter: parseInt(sec.getAttribute('data-ch'), 10), blocks: this._getBlocksIn(sec) };
            }
            return { chapter: this._chapterIndex, blocks: this._getBlocks(doc) };
        },

        _annFromSelection: function (doc, sel) {
            try {
                if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
                var range = sel.getRangeAt(0);
                var node = range.startContainer;
                var el = node.nodeType === 3 ? node.parentElement : node;
                var ctx = this._blocksForEl(doc, el);
                if (!ctx) return null;
                var block = null, bi = -1;
                for (var i = 0; i < ctx.blocks.length; i++) {
                    if (ctx.blocks[i].contains(range.startContainer)) { block = ctx.blocks[i]; bi = i; break; }
                }
                if (!block) return null;
                var offs = this._blockOffsets(block, range);
                if (!offs || offs.end <= offs.start) return null;
                var btext = block.textContent;
                var exact = btext.slice(offs.start, Math.min(offs.end, offs.start + 300));
                if (!exact.trim()) return null;
                return {
                    chapter: ctx.chapter,
                    para: bi,
                    fraction: ctx.blocks.length ? bi / ctx.blocks.length : 0,
                    exact: exact,
                    prefix: btext.slice(Math.max(0, offs.start - 40), offs.start),
                    suffix: btext.slice(offs.end, offs.end + 40)
                };
            } catch (e) { return null; }
        },

        _wireSelection: function (frame, doc) {
            var self = this;
            if (!doc || doc.abrSelWired) return;
            doc.abrSelWired = true;
            var onUp = function () { setTimeout(function () { self._maybeShowSelPopover(frame, doc); }, 30); };
            doc.addEventListener('mouseup', onUp);
            doc.addEventListener('touchend', onUp);
            // Keyboard selection (Shift+arrows / caret browsing)
            doc.addEventListener('keyup', function (e) { if (e.key === 'Shift') onUp(); });
            doc.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && document.getElementById('abr-sel-pop')) {
                    e.preventDefault(); e.stopPropagation();
                    self._hideSelPopover();
                    return;
                }
                if (!self._pendingSel) return;
                if (e.key === 'h' || e.key === 'H') { e.preventDefault(); self._createAnnotation('highlight', null); }
                else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); self._openNoteEditor(); }
            });
            doc.addEventListener('mousedown', function () { self._hideSelPopover(); });
        },

        _maybeShowSelPopover: function (frame, doc) {
            var sel = doc.getSelection && doc.getSelection();
            var payload = this._annFromSelection(doc, sel);
            if (!payload) { this._hideSelPopover(); return; }
            this._pendingSel = payload;
            var rect = sel.getRangeAt(0).getBoundingClientRect();
            this._showSelPopover(frame, rect);
            var info = document.getElementById('abr-chapter-info');
            if (info) info.textContent = 'Text selected. Press H to highlight, N to add a note.';
        },

        _showSelPopover: function (frame, rect) {
            var self = this;
            this._hideSelPopover(true);
            var pop = document.createElement('div');
            pop.id = 'abr-sel-pop';
            pop.setAttribute('role', 'toolbar');
            pop.setAttribute('aria-label', 'Selection actions');
            var mk = function (label, fn) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-col-choice';
                b.textContent = label;
                // mousedown would move focus and clear the iframe selection
                b.addEventListener('mousedown', function (e) { e.preventDefault(); });
                b.addEventListener('click', fn);
                pop.appendChild(b);
                return b;
            };
            mk('Highlight (H)', function () { self._createAnnotation('highlight', null); });
            mk('Add note (N)', function () { self._openNoteEditor(); });
            document.body.appendChild(pop);
            var fr = frame.getBoundingClientRect();
            var top = fr.top + rect.top - pop.offsetHeight - 8;
            if (top < 4) top = fr.top + rect.bottom + 8;
            var left = fr.left + rect.left + rect.width / 2 - pop.offsetWidth / 2;
            left = Math.max(4, Math.min(left, window.innerWidth - pop.offsetWidth - 4));
            pop.style.top = Math.max(4, top) + 'px';
            pop.style.left = left + 'px';
        },

        _hideSelPopover: function (keepPending) {
            var pop = document.getElementById('abr-sel-pop');
            if (pop) pop.remove();
            if (!keepPending) this._pendingSel = null;
        },

        _openNoteEditor: function () {
            var self = this;
            var pop = document.getElementById('abr-sel-pop');
            if (!pop) return;
            pop.innerHTML = '';
            pop.setAttribute('role', 'dialog');
            pop.setAttribute('aria-label', 'Add note');
            var ta = document.createElement('textarea');
            ta.className = 'abr-note-input';
            ta.setAttribute('aria-label', 'Note text');
            ta.rows = 3;
            var save = document.createElement('button');
            save.type = 'button';
            save.className = 'abr-col-choice';
            save.textContent = 'Save note';
            save.addEventListener('click', function () { self._createAnnotation('note', ta.value); });
            var cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'abr-col-choice';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', function () { self._hideSelPopover(); });
            pop.appendChild(ta);
            pop.appendChild(save);
            pop.appendChild(cancel);
            ta.focus();
        },

        _createAnnotation: function (type, body) {
            var self = this;
            var p = self._pendingSel;
            if (!p || !self._currentItemId) return;
            var item = self._spine[p.chapter] || {};
            var info = document.getElementById('abr-chapter-info');
            ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/annotations/' + self._currentItemId),
                type: 'POST',
                contentType: 'application/json',
                dataType: 'json',
                data: JSON.stringify({
                    Type: type,
                    Body: body || null,
                    Color: type === 'note' ? 'blue' : 'yellow',
                    Href: item.Href || item.href || null,
                    Locations: {
                        Chapter: p.chapter,
                        Progression: p.fraction,
                        TotalProgression: (p.chapter + p.fraction) / Math.max(1, self._spine.length),
                        Position: p.para
                    },
                    Text: { Before: p.prefix, Highlight: p.exact, After: p.suffix }
                })
            }).then(function (created) {
                self._annotations.push(self._normalizeAnnotation(created));
                self._hideSelPopover();
                var frame = document.getElementById('abr-frame');
                if (frame) {
                    try { frame.contentDocument.getSelection().removeAllRanges(); } catch (e) {}
                    self._paintAnnotations(frame);
                }
                self._renderBookmarksIfOpen();
                if (info) info.textContent = type === 'note' ? 'Note added' : 'Highlight added';
            }).catch(function () {
                if (info) info.textContent = 'Could not save ' + type;
            });
        },

        // Repaint all highlight/note ranges for the resident content. One CSS
        // Highlight registry per color; ranges are resolved block-first with a
        // quote-search fallback (the block index can drift across re-extracts).
        _paintAnnotations: function (frame) {
            var self = this;
            try {
                var doc = frame && frame.contentDocument;
                var win = frame && frame.contentWindow;
                if (!doc || !doc.body || !win) return;
                if (!win.CSS || !win.CSS.highlights || !win.Highlight) return;

                var st = doc.getElementById('abr-ann-style');
                if (!st) {
                    st = doc.createElement('style');
                    st.id = 'abr-ann-style';
                    var css = '';
                    for (var c in self._annColors) {
                        css += '::highlight(abr-ann-' + c + '){background-color:' + self._annColors[c] + ';color:#1a1a1a;}';
                    }
                    st.textContent = css;
                    doc.head.appendChild(st);
                }

                var regs = {};
                for (var col in self._annColors) {
                    var hl = new win.Highlight();
                    regs[col] = hl;
                    win.CSS.highlights.set('abr-ann-' + col, hl);
                }

                (self._annotations || []).forEach(function (a) {
                    if (a.type !== 'highlight' && a.type !== 'note') return;
                    if (!a.quote) return;
                    var blocks;
                    if (self._viewMode === 'scroll') {
                        var sec = self._scrollSections && self._scrollSections[a.chapter];
                        if (!sec) return;
                        blocks = self._getBlocksIn(sec);
                    } else {
                        if (a.chapter !== self._chapterIndex) return;
                        blocks = self._getBlocks(doc);
                    }
                    var block = (a.para != null) ? blocks[a.para] : null;
                    var idx = -1;
                    if (block) {
                        var btext = block.textContent;
                        if (a.before) {
                            idx = btext.indexOf(a.before + a.quote);
                            if (idx >= 0) idx += a.before.length;
                        }
                        if (idx < 0) idx = btext.indexOf(a.quote);
                    }
                    if (idx < 0) {
                        // Position drifted: quote-search every block
                        for (var b = 0; b < blocks.length; b++) {
                            var k = blocks[b].textContent.indexOf(a.quote);
                            if (k >= 0) { block = blocks[b]; idx = k; break; }
                        }
                    }
                    if (!block || idx < 0) return;
                    var range = self._rangeFromBlock(doc, block, idx, idx + a.quote.length);
                    if (!range) return;
                    var color = a.color || (a.type === 'note' ? 'blue' : 'yellow');
                    (regs[color] || regs.yellow).add(range);
                });
            } catch (e) {}
        },

        // Annotations tab in the Book map: every annotation type with filter,
        // search, jump-to, note editing, delete, and export (JSON-LD / Markdown).
        _renderAnnotationsTab: function (body) {
            var self = this;

            // Controls row: type filter + text search + export
            var controls = document.createElement('div');
            controls.className = 'abr-ann-controls';
            var filterLab = document.createElement('label');
            filterLab.className = 'abr-col-label';
            filterLab.textContent = 'Show';
            var filter = document.createElement('select');
            filter.id = 'abr-ann-filter';
            filter.className = 'abr-rotor-select';
            [['all', 'All'], ['bookmark', 'Bookmarks'], ['highlight', 'Highlights'], ['note', 'Notes']].forEach(function (o) {
                var opt = document.createElement('option');
                opt.value = o[0]; opt.textContent = o[1];
                if ((self._annFilter || 'all') === o[0]) opt.selected = true;
                filter.appendChild(opt);
            });
            filter.addEventListener('change', function () { self._annFilter = filter.value; self._renderBookMapTab('bookmarks'); });
            filterLab.appendChild(filter);
            var search = document.createElement('input');
            search.id = 'abr-ann-search';
            search.type = 'text';
            search.className = 'abr-goto-input';
            search.placeholder = 'Search annotations';
            search.setAttribute('aria-label', 'Search annotations');
            search.value = self._annSearch || '';
            search.addEventListener('input', function () { self._annSearch = search.value; renderRows(); });
            var mkExport = function (label, fmt) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'abr-col-choice';
                b.textContent = label;
                b.addEventListener('click', function () {
                    var token = (typeof ApiClient !== 'undefined' && ApiClient.accessToken) ? ApiClient.accessToken() : '';
                    var url = ApiClient.getUrl('A11yBookReader/annotations/' + self._currentItemId + '/export',
                        token ? { format: fmt, api_key: token } : { format: fmt });
                    var a = document.createElement('a');
                    a.href = url; a.download = '';
                    document.body.appendChild(a); a.click(); a.remove();
                });
                return b;
            };
            controls.appendChild(filterLab);
            controls.appendChild(search);
            controls.appendChild(mkExport('Export JSON', 'json'));
            controls.appendChild(mkExport('Export Markdown', 'md'));
            body.appendChild(controls);

            var listWrap = document.createElement('div');
            listWrap.id = 'abr-ann-list';
            body.appendChild(listWrap);

            var typeWord = { bookmark: 'Bookmark', highlight: 'Highlight', note: 'Note' };

            function renderRows() {
                listWrap.innerHTML = '';
                var f = self._annFilter || 'all';
                var q = (self._annSearch || '').toLowerCase();
                var list = (self._annotations || []).slice()
                    .filter(function (a) { return f === 'all' || a.type === f; })
                    .filter(function (a) {
                        if (!q) return true;
                        return ((a.quote || '') + ' ' + (a.body || '')).toLowerCase().indexOf(q) >= 0;
                    })
                    .sort(function (x, y) { return (x.chapter - y.chapter) || (x.fraction - y.fraction); });
                if (!list.length) {
                    listWrap.textContent = q || f !== 'all'
                        ? 'No matching annotations.'
                        : 'Nothing yet. Press B to bookmark, or select text to highlight or add a note.';
                    return;
                }
                list.forEach(function (a) {
                    var row = document.createElement('div');
                    row.className = 'abr-bm-row';
                    var label = typeWord[a.type] + ' · Chapter ' + (a.chapter + 1) + ' · ' + Math.round(a.fraction * 100) + '%' +
                        (a.quote ? ' — ' + a.quote : '');
                    var go = document.createElement('button');
                    go.type = 'button';
                    go.className = 'abr-map-item';
                    go.textContent = label;
                    if (a.body) {
                        var note = document.createElement('span');
                        note.className = 'abr-ann-note';
                        note.textContent = a.body;
                        go.appendChild(note);
                    }
                    go.addEventListener('click', function () {
                        // Exact locator restore (fraction + para) — jumpBtn's
                        // chapter+anchor path can't carry it
                        self._navStack.push(self._snapshotLocator());
                        self._updateBackBtn();
                        self._goToLocator(a);
                        self._toggleBookMap();
                        setTimeout(function () {
                            var info = document.getElementById('abr-chapter-info');
                            if (info) info.textContent = 'Jumped to ' + typeWord[a.type].toLowerCase();
                        }, 150);
                    });
                    row.appendChild(go);
                    if (a.type === 'note' || a.type === 'highlight') {
                        var edit = document.createElement('button');
                        edit.type = 'button';
                        edit.className = 'abr-icon-btn abr-bm-del';
                        edit.setAttribute('aria-label', 'Edit note: ' + label);
                        edit.innerHTML = '<span class="material-icons" aria-hidden="true">edit</span>';
                        edit.addEventListener('click', function () { editNote(a, row); });
                        row.appendChild(edit);
                    }
                    var del = document.createElement('button');
                    del.type = 'button';
                    del.className = 'abr-icon-btn abr-bm-del';
                    del.setAttribute('aria-label', 'Delete ' + typeWord[a.type].toLowerCase() + ': ' + label);
                    del.innerHTML = '<span class="material-icons" aria-hidden="true">delete</span>';
                    del.addEventListener('click', function () { self._deleteAnnotation(a, row); });
                    row.appendChild(del);
                    listWrap.appendChild(row);
                });
            }

            function editNote(a, row) {
                var ed = document.createElement('div');
                ed.className = 'abr-ann-edit';
                var ta = document.createElement('textarea');
                ta.className = 'abr-note-input';
                ta.setAttribute('aria-label', 'Note text');
                ta.rows = 3;
                ta.value = a.body || '';
                var save = document.createElement('button');
                save.type = 'button';
                save.className = 'abr-col-choice';
                save.textContent = 'Save';
                save.addEventListener('click', function () {
                    ApiClient.ajax({
                        url: ApiClient.getUrl('A11yBookReader/annotations/' + self._currentItemId + '/' + a.id),
                        type: 'POST',
                        contentType: 'application/json',
                        dataType: 'json',
                        data: JSON.stringify({ Body: ta.value })
                    }).then(function () {
                        a.body = ta.value;
                        renderRows();
                        var info = document.getElementById('abr-chapter-info');
                        if (info) info.textContent = 'Note saved';
                    }).catch(function () {});
                });
                var cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'abr-col-choice';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', function () { renderRows(); });
                ed.appendChild(ta);
                ed.appendChild(save);
                ed.appendChild(cancel);
                row.replaceWith(ed);
                ta.focus();
            }

            renderRows();
        },

        // Resolve a text quote to a block index (TextQuoteSelector-style):
        // the standards fallback that survives edition and layout changes.
        // Locate the block (paragraph) for a hit. `highlight` is the full
        // server quote; `term` is the bare search term. Case-insensitive.
        _findByQuote: function (doc, highlight, ordinal, term) {
            var want = ordinal || 0;
            try {
                var blocks = this._getBlocks(doc);
                var texts = [];
                for (var i = 0; i < blocks.length; i++)
                    texts.push((blocks[i].textContent || '').replace(/\s+/g, ' ').toLowerCase());

                // Pass 1 — full quote within a single block (unique → exact).
                // Fails when the quote spans a paragraph boundary, which is why
                // pass 2 exists.
                if (highlight) {
                    var hl = highlight.toLowerCase();
                    for (var a = 0; a < texts.length; a++)
                        if (texts[a].indexOf(hl) !== -1) return a;
                }

                // Pass 2 — the ordinal-th occurrence of the search term. The
                // term is short, always inside one block, so this survives the
                // boundary case. Uses the server's per-chapter occurrence index.
                if (term) {
                    var tm = term.toLowerCase();
                    var seen = 0;
                    for (var b = 0; b < texts.length; b++) {
                        var pos = texts[b].indexOf(tm);
                        while (pos !== -1) {
                            if (seen === want) return b;
                            seen++;
                            pos = texts[b].indexOf(tm, pos + 1);
                        }
                    }
                    // Ordinal overshot: first block containing the term
                    for (var c = 0; c < texts.length; c++)
                        if (texts[c].indexOf(tm) !== -1) return c;
                }
            } catch (e) {}
            return null;
        },

        // Block elements that anchor a reading position (layout-independent).
        // Memoized per synchronous turn: a single nav press queries this 4–5×
        // over the same unchanged doc.body. The block set only mutates across
        // event-loop turns (chapter load, scroll section load/trim — all async),
        // so the cached NodeList is valid for the duration of the current turn.
        // A microtask clears it, which is the one invalidation that can't miss a
        // mutation: it always runs before the next macrotask that could mutate.
        _getBlocks: function (doc) {
            if (this._blocksCache && this._blocksCache.doc === doc) return this._blocksCache.list;
            var list = doc.body.querySelectorAll(
                'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, dt, dd');
            this._blocksCache = { doc: doc, list: list };
            if (!this._blocksCacheScheduled) {
                this._blocksCacheScheduled = true;
                var self = this;
                Promise.resolve().then(function () {
                    self._blocksCache = null;
                    self._blocksCacheScheduled = false;
                });
            }
            return list;
        },

        // Index of the first block on the current page / in the viewport.
        // Paged mode uses offsetLeft (layout geometry — immune to the
        // mid-animation transform); scroll mode uses viewport rects.
        _firstVisiblePara: function () {
            if (this._viewMode === 'scroll') {
                try {
                    var sdoc = document.getElementById('abr-frame').contentDocument;
                    var sinfo = this._scrollActiveInfo(sdoc);
                    return sinfo ? sinfo.para : null;
                } catch (e) { return null; }
            }
            try {
                var frame = document.getElementById('abr-frame');
                var doc = frame.contentDocument;
                var blocks = this._getBlocks(doc);
                var i;
                if (this._viewMode === 'page') {
                    var pageStart = this._page * this._pageStep;
                    for (i = 0; i < blocks.length; i++) {
                        // First block whose column lies at or beyond this page
                        if (blocks[i].offsetLeft + blocks[i].offsetWidth / 2 >= pageStart) return i;
                    }
                    return blocks.length ? blocks.length - 1 : null;
                }
                for (i = 0; i < blocks.length; i++) {
                    var r = blocks[i].getBoundingClientRect();
                    if (r.bottom > 0 && r.top < doc.documentElement.clientHeight) return i;
                }
            } catch (e) {}
            return null;
        },

        // Jump to a paragraph anchor; returns false if it can't (caller falls
        // back to the fraction).
        _goToPara: function (para) {
            try {
                var frame = document.getElementById('abr-frame');
                var doc = frame.contentDocument;
                var blocks = this._getBlocks(doc);
                if (para == null || para < 0 || para >= blocks.length) return false;
                var el = blocks[para];
                if (this._viewMode === 'page') {
                    this._goToPage(Math.min(this._pageCount - 1,
                        Math.max(0, Math.round(el.offsetLeft / this._pageStep))), true);
                } else {
                    var win = frame.contentWindow;
                    win.scrollTo(0, el.getBoundingClientRect().top + win.pageYOffset - 16);
                    this._updateProgressUI();
                }
                return true;
            } catch (e) { return false; }
        },

        _currentScrollFraction: function () {
            // Paged mode: position is the page index, not a scroll offset
            if (this._viewMode === 'page') {
                return this._pageCount > 1 ? this._page / (this._pageCount - 1) : 0;
            }
            if (this._viewMode === 'scroll') {
                try {
                    var sdoc = document.getElementById('abr-frame').contentDocument;
                    var sinfo = this._scrollActiveInfo(sdoc);
                    return sinfo ? this._sectionFraction(sinfo.section) : 0;
                } catch (e) { return 0; }
            }
            try {
                var frame = document.getElementById('abr-frame');
                var win = frame && frame.contentWindow;
                var doc = win && win.document && win.document.documentElement;
                if (!doc) return 0;
                var max = doc.scrollHeight - doc.clientHeight;
                if (max <= 0) return 0;
                return Math.max(0, Math.min(1, win.pageYOffset / max));
            } catch (e) { return 0; }
        },

        _restoreScrollAndTrack: function (frame) {
            var self = this;
            try {
                var win = frame.contentWindow;
                var doc = win.document.documentElement;
                // Navigation jump: land on the requested anchor (or chapter top)
                if (self._pendingAnchor !== null) {
                    var anchor = self._pendingAnchor;
                    self._pendingAnchor = null;
                    if (anchor) self._goToAnchor(anchor);
                    else self._saveProgress(self._chapterIndex, 0, 0);
                }
                // Search-result jump: locate the quote (Nth occurrence) in the
                // freshly loaded chapter
                else if (self._pendingQuote !== null && self._pendingScrollFraction === null &&
                         self._pendingPara === null) {
                    var sq = self._pendingQuote;
                    var so = self._pendingQuoteOrdinal || 0;
                    var st = self._pendingQuoteTerm;
                    self._pendingQuote = null;
                    self._pendingQuoteTerm = null;
                    var sidx = self._findByQuote(win.document, sq, so, st);
                    if (sidx !== null) self._goToPara(sidx);
                    else self._saveProgress(self._chapterIndex, 0, 0);
                }
                // Apply the resume locator held from _openReader, exactly once.
                // Standards resolution order: structural Position → text quote
                // (survives layout/edition changes) → progression fallback.
                if (self._pendingScrollFraction !== null || self._pendingPara !== null) {
                    var f = self._pendingScrollFraction;
                    var pa = self._pendingPara;
                    var quote = self._pendingQuote;
                    self._pendingScrollFraction = null;
                    self._pendingPara = null;
                    self._pendingQuote = null;

                    // Verify the Position anchor against the quote when both
                    // exist; a mismatch means the layout/content shifted and
                    // the quote is the truth.
                    var target = pa;
                    if (quote) {
                        var quoteIdx = self._findByQuote(win.document, quote);
                        if (quoteIdx !== null && quoteIdx !== pa) target = quoteIdx;
                    }
                    // Play resumes reading from this exact paragraph (cleared
                    // if the user deliberately navigates away first)
                    self._ttsStartPara = target;
                    if (!self._goToPara(target) && f !== null) {
                        if (self._viewMode === 'page') {
                            self._goToPage(Math.round(f * (self._pageCount - 1)), true);
                        } else {
                            var max = doc.scrollHeight - doc.clientHeight;
                            if (max > 0 && f > 0) win.scrollTo(0, f * max);
                        }
                    }
                }
                // Debounced save while reading: 2s after scrolling stops
                win.addEventListener('scroll', function () {
                    // Manual scroll is a deliberate move: idle clears the resume
                    // hint; paused discards the stale paused stream so Play
                    // restarts here. (Active playback auto-scrolls — leave it.)
                    if (self._ttsPaused) self._navResetTts();
                    else if (!self._ttsPlaying) self._ttsStartPara = null;
                    self._updateProgressUI();
                    if (self._scrollSaveTimer) clearTimeout(self._scrollSaveTimer);
                    self._scrollSaveTimer = setTimeout(function () {
                        self._saveProgress(self._chapterIndex, self._currentScrollFraction(),
                            self._firstVisiblePara());
                    }, 2000);
                });
                self._updateProgressUI();
            } catch (e) {}
        }
    };

    // Boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { window.a11yBookReader.init(); });
    } else {
        window.a11yBookReader.init();
    }
}
