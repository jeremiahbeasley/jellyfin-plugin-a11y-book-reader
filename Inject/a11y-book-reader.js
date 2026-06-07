'use strict';

if (typeof window.a11yBookReader === 'undefined') {
    window.a11yBookReader = {

        _currentItemId: null,
        _spine: [],
        _chapterIndex: 0,
        _pendingScrollFraction: null,
        _pendingPara: null,
        _pendingQuote: null,
        _ttsStartPara: null,   // restored Position: where Play resumes reading
        _ttsSaveTimer: null,   // 10s interval persisting the spoken position
        // Display settings (Phase 2 colophon) — server-synced, cross-device
        _ds: null,
        _dsSaveTimer: null,
        _dsDefaults: {
            FontFamily: 'publisher', FontSizePct: 100, LineHeightPct: 150,
            LetterSpacing: 0, WordSpacing: 0, ParaSpacingPct: 100,
            MarginPct: 6, Align: 'left', Theme: 'light',
            CustomFg: '#1a1a1a', CustomBg: '#fafaf7',
            ReducedMotion: false, ViewMode: 'scroll', Ruler: false, TtsRatePct: 100
        },
        _scrollSaveTimer: null,
        // Reading view state (Phase 1)
        _viewMode: 'scroll',     // 'paged' | 'scroll'
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
                self._viewMode = ds.ViewMode === 'paged' ? 'paged' : 'scroll';
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
                        self._pendingScrollFraction = fr;
                        self._pendingPara = pa;
                        self._pendingQuote = txt ? (txt.Highlight || txt.highlight || null) : null;
                        self._loadChapter(ch);
                        // Prefix the live region so screen readers hear that this is a resume
                        var info = document.getElementById('abr-chapter-info');
                        if (info) info.textContent = 'Resuming at ' + info.textContent;
                    } else {
                        self._loadChapter(0);
                    }
                }).catch(function () {
                    self._loadChapter(0);
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
            toolbar.appendChild(ttsBtn);

            var ttsStopBtn = document.createElement('button');
            ttsStopBtn.id = 'abr-tts-stop';
            ttsStopBtn.type = 'button';
            ttsStopBtn.className = 'abr-icon-btn';
            ttsStopBtn.setAttribute('aria-label', 'Stop audio');
            ttsStopBtn.setAttribute('hidden', '');
            ttsStopBtn.innerHTML = '<span class="material-icons" aria-hidden="true">stop</span>';
            ttsStopBtn.addEventListener('click', function () { self._stopTts(); });
            toolbar.appendChild(ttsStopBtn);

            var ttsSettingsBtn = document.createElement('button');
            ttsSettingsBtn.id = 'abr-tts-settings-btn';
            ttsSettingsBtn.type = 'button';
            ttsSettingsBtn.className = 'abr-icon-btn';
            ttsSettingsBtn.setAttribute('aria-label', 'Reading settings');
            ttsSettingsBtn.setAttribute('aria-expanded', 'false');
            ttsSettingsBtn.setAttribute('aria-controls', 'abr-tts-settings');
            ttsSettingsBtn.innerHTML = '<span class="material-icons" aria-hidden="true">tune</span>';
            ttsSettingsBtn.addEventListener('click', function () {
                var panel = document.getElementById('abr-tts-settings');
                var open = panel.hasAttribute('hidden');
                if (open) { panel.removeAttribute('hidden'); ttsSettingsBtn.setAttribute('aria-expanded', 'true'); }
                else { panel.setAttribute('hidden', ''); ttsSettingsBtn.setAttribute('aria-expanded', 'false'); }
            });
            toolbar.appendChild(ttsSettingsBtn);

            // View mode toggle: paged vs continuous scroll
            var modeBtn = document.createElement('button');
            modeBtn.id = 'abr-mode-toggle';
            modeBtn.type = 'button';
            modeBtn.className = 'abr-icon-btn';
            // Constant name + state (4.1.2): "Paged reading, pressed/not pressed"
            modeBtn.setAttribute('aria-label', 'Paged reading');
            modeBtn.setAttribute('aria-pressed', self._viewMode === 'paged' ? 'true' : 'false');
            modeBtn.innerHTML = '<span class="material-icons" aria-hidden="true">' +
                (self._viewMode === 'paged' ? 'auto_stories' : 'view_day') + '</span>';
            modeBtn.addEventListener('click', function () { self._toggleViewMode(); });
            toolbar.appendChild(modeBtn);

            // Reading ruler toggle
            var rulerBtn = document.createElement('button');
            rulerBtn.id = 'abr-ruler-toggle';
            rulerBtn.type = 'button';
            rulerBtn.className = 'abr-icon-btn';
            rulerBtn.setAttribute('aria-label', 'Reading ruler');
            rulerBtn.setAttribute('aria-pressed', self._rulerOn ? 'true' : 'false');
            rulerBtn.innerHTML = '<span class="material-icons" aria-hidden="true">horizontal_rule</span>';
            rulerBtn.addEventListener('click', function () { self._toggleRuler(); });
            toolbar.appendChild(rulerBtn);

            // Display settings (colophon)
            var colophonBtn = document.createElement('button');
            colophonBtn.id = 'abr-colophon-btn';
            colophonBtn.type = 'button';
            colophonBtn.className = 'abr-icon-btn';
            colophonBtn.setAttribute('aria-label', 'Display settings');
            colophonBtn.setAttribute('aria-expanded', 'false');
            colophonBtn.setAttribute('aria-controls', 'abr-colophon');
            colophonBtn.innerHTML = '<span class="material-icons" aria-hidden="true">text_format</span>';
            colophonBtn.addEventListener('click', function () { self._toggleColophon(); });
            toolbar.appendChild(colophonBtn);

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

            var closeBtn = document.createElement('button');
            closeBtn.id = 'abr-close';
            closeBtn.type = 'button';
            closeBtn.className = 'abr-icon-btn';
            closeBtn.setAttribute('aria-label', 'Close reader');
            closeBtn.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';
            closeBtn.addEventListener('click', function () { self._closeReader(); });

            toolbar.appendChild(titleEl);
            toolbar.appendChild(chapterInfo);
            toolbar.appendChild(closeBtn);

            // TTS settings panel
            {
                var settingsPanel = document.createElement('div');
                settingsPanel.id = 'abr-tts-settings';
                settingsPanel.setAttribute('hidden', '');
                settingsPanel.setAttribute('aria-label', 'Reading settings');
                settingsPanel.setAttribute('role', 'group');

                // Speed
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
                    opt.value = String(r);
                    opt.textContent = r + '×';
                    if (r === self._ttsRate) opt.selected = true;
                    speedSelect.appendChild(opt);
                });
                speedSelect.addEventListener('change', function () {
                    self._ttsRate = parseFloat(speedSelect.value);
                    if (self._ds) { self._ds.TtsRatePct = Math.round(self._ttsRate * 100); self._saveDisplaySettings(); }
                    if (self._ttsPlaying && !self._ttsPaused) {
                        if (self._piperAudio) {
                            // Speed is baked into the synthesis — restart the
                            // stream from the current position at the new rate
                            var dur = (isFinite(self._piperAudio.duration) && self._piperAudio.duration > 0)
                                ? self._piperAudio.duration : self._piperAudio.abrEstDuration;
                            var frac = dur ? Math.min(self._piperAudio.currentTime / dur, 1) : 0;
                            var charLen = self._ttsFullText.length - self._ttsCharOffset;
                            self._ttsCharOffset += Math.floor(frac * charLen);
                            self._stopPiperTts();
                            self._ttsPlaying = false;
                            self._startTts();
                        } else if (self._isTvVoice()) {
                            self._stopTvTts();
                            self._ttsPlaying = false;
                            self._startTts();
                        } else if (typeof window.speechSynthesis !== 'undefined') {
                            self._ttsCharOffset += self._ttsLastBoundary;
                            self._ttsLastBoundary = 0;
                            window.speechSynthesis.cancel();
                            self._ttsPlaying = false;
                            self._ttsUtterance = null;
                            self._startTts();
                        }
                    }
                });
                speedGroup.appendChild(speedLabel);
                speedGroup.appendChild(speedSelect);

                // Voice
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

                    // Save the current chapter position before tearing down.
                    // NOTE: a live MP3 stream reports a finite, *growing*
                    // .duration (the buffered length), which pins
                    // currentTime/duration near 1 — only the text-length
                    // estimate is an honest clock here.
                    if (self._piperAudio) {
                        var a = self._piperAudio;
                        var dur = a.abrEstDuration;
                        var frac = dur ? Math.min(a.currentTime / dur, 1) : 0;
                        if (a.abrCost) {
                            self._ttsCharOffset += self._costToChar(a.abrCost, frac * a.abrCost[a.abrCost.length - 1]);
                        } else {
                            var charLen = self._ttsFullText.length - self._ttsCharOffset;
                            self._ttsCharOffset += Math.floor(frac * charLen);
                        }
                    } else if (self._hlTicker && self._hlTickLast != null) {
                        self._ttsCharOffset = self._hlTickLast;
                    } else {
                        self._ttsCharOffset += self._ttsLastBoundary;
                    }
                    self._ttsLastBoundary = 0;
                    self._stopHlTicker();
                    self._stopPiperTts();
                    self._stopTvTts();
                    if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
                    self._ttsUtterance = null;

                    if (self._ttsPlaying && !self._ttsPaused) {
                        // Playing: restart immediately with the new voice
                        self._ttsPlaying = false;
                        self._startTts();
                    }
                    // Paused: stay paused — _toggleTts's resume path detects the
                    // discarded stream and starts fresh with the new voice.
                });
                voiceGroup.appendChild(voiceLabel);
                voiceGroup.appendChild(voiceSelect);

                settingsPanel.appendChild(speedGroup);
                settingsPanel.appendChild(voiceGroup);
                overlay.appendChild(settingsPanel);
            }

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
            prevBtn.innerHTML = '<span class="material-icons" aria-hidden="true">chevron_left</span> Previous';
            prevBtn.addEventListener('click', function () { self._turn(-1); });

            var chapterLabel = document.createElement('span');
            chapterLabel.id = 'abr-chapter-label';
            chapterLabel.className = 'abr-chapter-label';

            // Page / percent readout (live region politely announces position)
            var pageInfo = document.createElement('span');
            pageInfo.id = 'abr-page-info';
            pageInfo.className = 'abr-chapter-label';
            // Page turns announce in paged mode; scrolling stays quiet
            pageInfo.setAttribute('aria-live', self._viewMode === 'paged' ? 'polite' : 'off');

            var nextBtn = document.createElement('button');
            nextBtn.id = 'abr-next';
            nextBtn.type = 'button';
            nextBtn.className = 'abr-nav-btn';
            nextBtn.setAttribute('aria-label', 'Next chapter');
            nextBtn.innerHTML = 'Next <span class="material-icons" aria-hidden="true">chevron_right</span>';
            nextBtn.addEventListener('click', function () { self._turn(1); });

            var mid = document.createElement('span');
            mid.className = 'abr-nav-mid';
            mid.appendChild(chapterLabel);
            mid.appendChild(pageInfo);

            nav.appendChild(prevBtn);
            nav.appendChild(mid);
            nav.appendChild(nextBtn);

            overlay.appendChild(toolbar);
            overlay.appendChild(contentArea);
            overlay.appendChild(nav);

            // Swipe on the chrome: page in paged mode, chapter in scroll mode
            var touchStartX = 0;
            overlay.addEventListener('touchstart', function (e) {
                touchStartX = e.touches[0].clientX;
            }, { passive: true });
            overlay.addEventListener('touchend', function (e) {
                var dx = e.changedTouches[0].clientX - touchStartX;
                if (Math.abs(dx) > 50) self._turn(dx < 0 ? 1 : -1);
            });

            // Colophon panel (display settings) — lives between toolbar and content
            overlay.insertBefore(self._buildColophon(), contentArea);

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

            // Load chapter HTML into iframe
            var src = '/A11yBookReader/chapter/' + self._currentItemId + '/' + self._chapterIndex;

            // Persist chapter turns immediately — but not when this load IS the
            // resume jump (the pending anchor would be clobbered with 0).
            // No text/Position anchor here: the OLD chapter is still in the
            // frame, so any quote grabbed now would be from the wrong chapter.
            if (self._pendingScrollFraction === null && self._pendingPara === null) {
                self._saveProgress(self._chapterIndex, 0, null);
            }
            frame.src = src;

            frame.onload = function () {
                self._setupChapterView(frame);
                self._restoreScrollAndTrack(frame);
                self._tvFocusSweep(document.getElementById('abr-overlay'));
                // Auto-start TTS if continuous reading is active
                if (self._ttsContinuous) {
                    self._updateTtsButtons(true);
                    self._startTts();
                }
            };
        },

        _navigateChapter: function (delta) {
            this._enterAtEnd = (delta < 0 && this._viewMode === 'paged');
            this._loadChapter(this._chapterIndex + delta);
        },

        // ── Reading View Engine (Phase 1) ────────────────────────────────────

        // Unified turn: pages within the chapter first, chapters at the edges.
        _turn: function (delta) {
            // Deliberate navigation: Play now starts from where the user moved
            this._ttsStartPara = null;
            // Book edges: nothing past the last page of the last chapter,
            // nothing before the first page of the first one.
            var atLastChapter = this._chapterIndex >= this._spine.length - 1;
            var atFirstChapter = this._chapterIndex <= 0;
            if (this._viewMode === 'paged') {
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
                    if (e.target.closest('a, button, input, select, textarea')) return;
                    var sel = doc.getSelection && doc.getSelection();
                    if (sel && sel.toString()) return;
                    var x = e.clientX / doc.documentElement.clientWidth;
                    // Middle-third tap toggles controls in BOTH modes (QA defect #3);
                    // side tap zones page-turn only in paged mode
                    if (x >= 0.33 && x <= 0.66) { self._setImmersive(!self._immersive); return; }
                    if (self._viewMode !== 'paged') return;
                    self._turn(x < 0.33 ? -1 : 1);
                });
                // Swipe inside the content
                var sx = 0;
                doc.addEventListener('touchstart', function (e) {
                    sx = e.touches[0].clientX;
                }, { passive: true });
                doc.addEventListener('touchend', function (e) {
                    var dx = e.changedTouches[0].clientX - sx;
                    if (Math.abs(dx) > 50) self._turn(dx < 0 ? 1 : -1);
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
        },

        _applyViewMode: function (frame, doc, style) {
            var self = this;
            var w = frame.clientWidth;
            var keepFraction = self._pageCount > 1 ? self._page / (self._pageCount - 1) : 0;
            var ds = self._ds || self._dsDefaults;
            // Margin setting drives the page gutters in both modes
            var marginPx = Math.round(w * ds.MarginPct / 100);
            var reading = self._readingCss();

            if (self._viewMode === 'paged') {
                style.textContent = reading +
                    'html{height:100%;overflow:hidden;}' +
                    // NOTE: no overflow:hidden on body — an element's overflow
                    // clip moves WITH its own transform, so a clipped body
                    // slides its window off-screen on page turns (blank page).
                    // The static html element does the clipping instead.
                    'body{height:100%;margin:0;padding:24px ' + marginPx + 'px;box-sizing:border-box;' +
                    'column-width:' + (w - marginPx * 2) + 'px;column-gap:' + (marginPx * 2) + 'px;column-fill:auto;}' +
                    'img,svg,video{max-width:100%;max-height:90vh;}' +
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
                var entry = self._enterAtEnd ? self._pageCount - 1
                    : Math.round(keepFraction * (self._pageCount - 1));
                self._enterAtEnd = false;
                self._goToPage(Math.min(entry, self._pageCount - 1), true);
            } else {
                style.textContent = reading +
                    'html{overflow-y:auto;}' +
                    'body{margin:0;padding:24px ' + marginPx + 'px;column-width:auto;transform:none;}' +
                    'img,svg,video{max-width:100%;}';
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
        _updateProgressUI: function () {
            var spineLen = Math.max(1, this._spine.length);
            var within = this._viewMode === 'paged'
                ? (this._pageCount > 1 ? this._page / (this._pageCount - 1) : 1)
                : this._currentScrollFraction();
            var bookPct = Math.round(((this._chapterIndex + within) / spineLen) * 100);

            var fill = document.getElementById('abr-ribbon-fill');
            if (fill) fill.style.height = bookPct + '%';

            var pageInfo = document.getElementById('abr-page-info');
            var ribbon = document.getElementById('abr-ribbon');
            var text, announce;
            if (this._viewMode === 'paged') {
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

        _toggleViewMode: function () {
            // Capture the reading position under the OUTGOING mode so the
            // switch lands in the same place, not at the top (QA defect #1).
            // The paragraph anchor survives the relayout; fraction is fallback.
            var keepPara = this._firstVisiblePara();
            var keep = this._currentScrollFraction();
            this._viewMode = this._viewMode === 'paged' ? 'scroll' : 'paged';
            this._pendingScrollFraction = keep;
            if (this._ds) { this._ds.ViewMode = this._viewMode; this._saveDisplaySettings(); }
            var btn = document.getElementById('abr-mode-toggle');
            if (btn) {
                btn.setAttribute('aria-pressed', this._viewMode === 'paged' ? 'true' : 'false');
                btn.innerHTML = '<span class="material-icons" aria-hidden="true">' +
                    (this._viewMode === 'paged' ? 'auto_stories' : 'view_day') + '</span>';
            }
            var frame = document.getElementById('abr-frame');
            if (frame) {
                this._setupChapterView(frame);
                // Consume the carried position now — no frame reload happens here.
                // Paragraph anchor first; fraction only if it fails.
                var f = this._pendingScrollFraction;
                this._pendingScrollFraction = null;
                if (!this._goToPara(keepPara) && f !== null) {
                    if (this._viewMode === 'paged') {
                        this._goToPage(Math.round(f * (this._pageCount - 1)), true);
                    } else {
                        try {
                            var win = frame.contentWindow, doc = win.document.documentElement;
                            var max = doc.scrollHeight - doc.clientHeight;
                            if (max > 0) win.scrollTo(0, f * max);
                        } catch (e) {}
                        this._updateProgressUI();
                    }
                }
            }
            // pageInfo announces page turns in paged mode; stays quiet while scrolling
            var pageInfo = document.getElementById('abr-page-info');
            if (pageInfo) pageInfo.setAttribute('aria-live',
                this._viewMode === 'paged' ? 'polite' : 'off');
            var info = document.getElementById('abr-chapter-info');
            if (info) info.textContent = this._viewMode === 'paged'
                ? 'Paged reading' : 'Continuous scroll';
        },

        _toggleRuler: function () {
            this._rulerOn = !this._rulerOn;
            if (this._ds) { this._ds.Ruler = this._rulerOn; this._saveDisplaySettings(); }
            var btn = document.getElementById('abr-ruler-toggle');
            if (btn) btn.setAttribute('aria-pressed', this._rulerOn ? 'true' : 'false');
            var ruler = document.getElementById('abr-ruler');
            if (ruler) {
                if (this._rulerOn) {
                    ruler.removeAttribute('hidden');
                    // Keyboard/remote default: fixed reading line at 38% height
                    var area = document.getElementById('abr-content-area');
                    if (area) ruler.style.top = (area.getBoundingClientRect().top +
                        area.clientHeight * 0.38) + 'px';
                } else {
                    ruler.setAttribute('hidden', '');
                }
            }
        },

        _setImmersive: function (on) {
            // Close the colophon properly first so its button's aria-expanded
            // stays truthful while the panel is hidden by immersive mode
            if (on) {
                var colophon = document.getElementById('abr-colophon');
                if (colophon && !colophon.hasAttribute('hidden')) this._toggleColophon();
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

            // Escape / TV back, in priority order: close the colophon panel →
            // close TTS settings → leave immersive → close the reader
            if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
                e.preventDefault();
                var colophon = document.getElementById('abr-colophon');
                if (colophon && !colophon.hasAttribute('hidden')) { this._toggleColophon(); return; }
                var ttsPanel = document.getElementById('abr-tts-settings');
                if (ttsPanel && !ttsPanel.hasAttribute('hidden')) {
                    ttsPanel.setAttribute('hidden', '');
                    var tsBtn = document.getElementById('abr-tts-settings-btn');
                    if (tsBtn) { tsBtn.setAttribute('aria-expanded', 'false'); tsBtn.focus(); }
                    return;
                }
                if (this._immersive) { this._setImmersive(false); return; }
                this._closeReader(); return;
            }
            // p = play/pause TTS
            if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this._toggleTts(); return; }

            // Reading keys while the book frame has focus: act on the content
            var frame = document.getElementById('abr-frame');
            if (document.activeElement === frame) {
                if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault(); this._turn(1); return;
                }
                if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                    e.preventDefault(); this._turn(-1); return;
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
                if (this._viewMode === 'paged' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault(); this._turn(e.key === 'ArrowDown' ? 1 : -1); return;
                }
                if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    if (this._viewMode === 'paged') {
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
                var focusable = Array.from(
                    overlay.querySelectorAll('button:not([disabled]), iframe[tabindex="0"], [tabindex="0"]')
                ).filter(function (el) { return !el.closest('[hidden]'); });
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
                if (this._piperAudio && this._piperAudio.abrCost) {
                    var a = this._piperAudio;
                    var dur = a.abrEstDuration;
                    var frac = dur ? Math.min(a.currentTime / dur, 1) : 0;
                    abs += this._costToChar(a.abrCost, frac * a.abrCost[a.abrCost.length - 1]);
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

        _startTts: function () {
            var self = this;
            // Fresh start (not a pause-resume or mid-read restart): begin at
            // the paragraph the book resumed at — the one that was being
            // read — falling back to the current visual position.
            if (!self._ttsPaused && self._ttsCharOffset === 0) {
                var startPara = (self._ttsStartPara !== null && self._ttsStartPara !== undefined)
                    ? self._ttsStartPara : self._firstVisiblePara();
                self._ttsStartPara = null;
                self._ttsCharOffset = self._paraCharOffset(startPara);
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

            // Build text + offset map once per chapter; reuse on mid-read restarts
            if (!self._ttsFullText) {
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
            if (doc && doc.body) walk(doc.body);
            return {text: text, map: map};
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
                var nodeOff = offset - entry.absStart;
                var nodeEnd = Math.min(nodeOff + (length || 1), entry.node.textContent.length);
                if (nodeEnd <= nodeOff) return;

                var range = iframeDoc.createRange();
                range.setStart(entry.node, nodeOff);
                range.setEnd(entry.node, nodeEnd);
                var rect = range.getBoundingClientRect();
                if (!rect || (rect.width === 0 && rect.height === 0)) return;

                var box = iframeDoc.getElementById('abr-hl-box');
                if (!box) {
                    box = iframeDoc.createElement('div');
                    box.id = 'abr-hl-box';
                    box.style.cssText = 'position:absolute;pointer-events:none;' +
                        'background:rgba(255,215,0,.45);border-radius:2px;' +
                        'z-index:2147483647;' +
                        (this._reducedMotion ? '' : 'transition:left 80ms,top 80ms,width 80ms;');
                    iframeDoc.body.appendChild(box);
                }
                if (this._viewMode === 'paged') {
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
                if (this._viewMode === 'paged') {
                    var bRect = iframeDoc.body.getBoundingClientRect();
                    var layoutX = rect.left - bRect.left;
                    var targetPage = Math.max(0, Math.min(this._pageCount - 1,
                        Math.floor(layoutX / this._pageStep)));
                    if (targetPage !== this._page) this._goToPage(targetPage);
                } else if (entry.node.parentElement) {
                    var el = entry.node.parentElement;
                    var erect = el.getBoundingClientRect();
                    var vh = iframeWin.innerHeight || iframeDoc.documentElement.clientHeight;
                    if (erect.top < vh * 0.15 || erect.bottom > vh * 0.85) {
                        el.scrollIntoView({block: 'center', behavior: 'smooth'});
                    }
                }
            } catch (e) {}
        },

        _clearTtsSelection: function (frame) {
            try {
                if (frame && frame.contentDocument) {
                    var box = frame.contentDocument.getElementById('abr-hl-box');
                    if (box) box.style.display = 'none';
                }
            } catch (e) {}
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

        // Cumulative "speech cost" of the text: 1 per character plus pause
        // weights at punctuation — Piper inserts real silence at sentence and
        // clause breaks, which a flat chars/sec clock drifts past. atempo
        // scales speech and pauses uniformly, so one rate term stays valid
        // at every speed.
        _buildPiperCost: function (text) {
            var n = text.length;
            var cum = new Float64Array(n + 1);
            var c = 0;
            var prevWs = false;
            for (var i = 0; i < n; i++) {
                var ch = text[i];
                var isWs = ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
                var w;
                if (isWs) {
                    // Piper collapses whitespace: a whole run is one word
                    // separator. Pretty-printed EPUB markup yields huge
                    // indentation runs that are never spoken — billing them
                    // per character made the highlight crawl behind the voice.
                    // Paragraph breaks measured ~0 extra pause beyond the
                    // sentence pause, so newlines get no bonus.
                    w = prevWs ? 0 : 1;
                } else {
                    w = 1;
                    if (ch === '.' || ch === '!' || ch === '?') w += 9;       // sentence pause
                    else if (ch === ',' || ch === ';' || ch === ':') w += 3;  // clause pause (measured 0.15s)
                }
                prevWs = isWs;
                c += w;
                cum[i + 1] = c;
            }
            return cum;
        },

        // Largest char index whose cumulative cost is <= target (binary search)
        _costToChar: function (cum, target) {
            var lo = 0, hi = cum.length - 1;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (cum[mid] < target) lo = mid + 1; else hi = mid;
            }
            return Math.max(0, lo - 1);
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

            // Fetch downloaded Piper voices and build the unified dropdown
            ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/piper/voices'),
                type: 'GET',
                dataType: 'json'
            }).then(function (piperVoices) {
                var fresh = hasSpeech ? window.speechSynthesis.getVoices() : [];
                self._buildVoiceSelect(document.getElementById('abr-voice-select'), fresh, piperVoices || []);
            }).catch(function () {
                self._buildVoiceSelect(document.getElementById('abr-voice-select'), browserVoices, []);
            });
        },

        _buildVoiceSelect: function (select, browserVoices, piperVoices) {
            if (!select) return;
            var currentURI = this._ttsVoiceURI;
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

            // Browser voices optgroup
            var bg = document.createElement('optgroup');
            bg.label = 'Browser voices';
            var def = document.createElement('option');
            def.value = '';
            def.textContent = 'Default';
            if (!currentURI) def.selected = true;
            bg.appendChild(def);
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

        _startPiperTts: function () {
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
                    if (next < self._spine.length) { self._loadChapter(next); }
                    else { self._ttsContinuous = false; self._updateTtsButtons(); }
                }
                return;
            }

            var voiceKey = self._ttsVoiceURI.slice(6);
            self._ttsPlaying = true;
            self._updateTtsButtons();

            // Step 1: register the text server-side (small fast POST), get a stream id
            var xhr = new XMLHttpRequest();
            xhr.open('POST', ApiClient.getUrl('A11yBookReader/tts/prepare'));
            xhr.setRequestHeader('Content-Type', 'application/json');
            var token = window.ApiClient && ApiClient.accessToken ? ApiClient.accessToken() : '';
            if (token) xhr.setRequestHeader('X-Emby-Authorization', 'MediaBrowser Token="' + token + '"');
            xhr.responseType = 'json';
            self._piperXhr = xhr;

            xhr.onload = function () {
                self._piperXhr = null;
                var id = (xhr.status === 200 && xhr.response) ? xhr.response.id : null;
                if (!id) {
                    self._ttsPlaying = false;
                    self._updateTtsButtons();
                    return;
                }

                // Step 2: play the stream — audio starts as soon as the first
                // sentence is synthesized instead of waiting for the whole chapter.
                // Speed is baked into the synthesis server-side (--length_scale);
                // playbackRate is ignored by browsers on unknown-length streams.
                var url = ApiClient.getUrl('A11yBookReader/tts/stream/' + id, token ? { api_key: token } : {});
                // Reuse the gesture-blessed element (iOS) — fall back to a fresh
                // one if playback starts without a gesture having created it.
                var audio = self._piperAudioEl || (self._piperAudioEl = new Audio());
                // Scrub leftovers from a naturally-ended previous stream: its
                // stale currentTime would otherwise feed the first timeupdate
                // events and march the highlight ahead during the silent gap.
                audio.ontimeupdate = null;
                audio.onended = null;
                audio.onerror = null;
                try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
                // on* properties (not addEventListener) so handlers are replaced,
                // not stacked, each time the element is reused for a new stream.
                // Live streams misreport .duration (it grows with the buffer), so
                // progress runs off a pause-weighted cost model: ~20 cost-units/sec
                // at 1× (measured against real Piper output), scaled by speed.
                var cost = self._buildPiperCost(text);
                audio.abrCost = cost;
                audio.abrEstDuration = cost[cost.length - 1] / (20 * self._ttsRate);
                self._piperAudio = audio;

                audio.ontimeupdate = function () {
                    // Only trust the clock while audio is actually playing —
                    // early events before decodable data carry stale times
                    if (audio.paused || audio.seeking || audio.readyState < 2) return;
                    // Don't read audio.duration: a live chunked stream reports
                    // a finite, growing duration (the buffered length), pinning
                    // the fraction near 1. Map elapsed time through the
                    // pause-weighted cost model instead.
                    var total = audio.abrEstDuration;
                    var cum = audio.abrCost;
                    if (!total || !cum) return;
                    var frac = Math.min(audio.currentTime / total, 1);
                    var rel = self._costToChar(cum, frac * cum[cum.length - 1]);
                    var absOff = self._ttsCharOffset + rel;
                    var w = self._snapToWord(absOff);
                    if (w) self._highlightWord(frame, w.start, w.len);
                };

                audio.onended = function () {
                    self._piperAudio = null;
                    self._ttsPlaying = false;
                    self._ttsPaused = false;
                    self._ttsCharOffset = 0;
                    self._ttsFullText = '';
                    self._ttsLastBoundary = 0;
                    self._ttsOffsetMap = [];
                    self._clearTtsSelection(frame);

                    if (self._ttsContinuous) {
                        var nextCh = self._chapterIndex + 1;
                        if (nextCh < self._spine.length) { self._loadChapter(nextCh); }
                        else { self._ttsContinuous = false; self._updateTtsButtons(); var info = document.getElementById('abr-chapter-info'); if (info) info.textContent = 'End of book'; }
                    } else { self._updateTtsButtons(); }
                };

                audio.onerror = function () {
                    self._piperAudio = null;
                    self._ttsPlaying = false;
                    self._ttsPaused = false;
                    self._ttsContinuous = false;
                    self._updateTtsButtons();
                };

                audio.src = url;
                var played = audio.play();
                if (played && played.catch) {
                    played.catch(function () {
                        // iOS NotAllowedError (or decode failure) — surface as stopped
                        self._piperAudio = null;
                        self._ttsPlaying = false;
                        self._ttsPaused = false;
                        self._ttsContinuous = false;
                        self._updateTtsButtons();
                    });
                }
            };

            xhr.onerror = function () {
                self._piperXhr = null;
                self._ttsPlaying = false;
                self._updateTtsButtons();
            };

            xhr.send(JSON.stringify({ text: text, voice: voiceKey, rate: self._ttsRate }));
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
                    if (next < self._spine.length) { self._loadChapter(next); }
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

        // ── Display Settings (colophon) ──────────────────────────────────────

        _fetchDisplaySettings: function () {
            var self = this;
            return ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/settings'),
                type: 'GET',
                dataType: 'json'
            }).then(function (s) {
                self._ds = self._mergeSettings(s);
            }).catch(function () {
                // No server settings yet (or offline): local cache, then defaults
                try {
                    var raw = localStorage.getItem('abr-display-' +
                        (ApiClient.getCurrentUserId ? ApiClient.getCurrentUserId() : 'anon'));
                    self._ds = self._mergeSettings(raw ? JSON.parse(raw) : null);
                } catch (e) { self._ds = self._mergeSettings(null); }
            });
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

        // ── Colophon Panel (display settings UI) ─────────────────────────────

        _toggleColophon: function () {
            var panel = document.getElementById('abr-colophon');
            var btn = document.getElementById('abr-colophon-btn');
            if (!panel) return;
            var opening = panel.hasAttribute('hidden');
            if (opening) {
                panel.removeAttribute('hidden');
                if (btn) btn.setAttribute('aria-expanded', 'true');
                var first = panel.querySelector('button, input, select');
                if (first) first.focus();
            } else {
                panel.setAttribute('hidden', '');
                if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
            }
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
            return row;
        },

        _buildColophon: function () {
            var self = this;
            var panel = document.createElement('div');
            panel.id = 'abr-colophon';
            panel.setAttribute('role', 'group');
            panel.setAttribute('aria-label', 'Display settings');
            panel.setAttribute('hidden', '');

            // Type
            panel.appendChild(self._mkChoices('Font', 'FontFamily', [
                { value: 'publisher', label: 'Book' },
                { value: 'serif', label: 'Serif', style: 'font-family:Georgia,serif' },
                { value: 'sans', label: 'Sans', style: 'font-family:system-ui,sans-serif' },
                { value: 'opendyslexic', label: 'OpenDyslexic' }
            ]));
            panel.appendChild(self._mkStepper('Text size', 'FontSizePct', 70, 250, 10,
                function (v) { return v + '%'; }));
            panel.appendChild(self._mkStepper('Line spacing', 'LineHeightPct', 100, 250, 10,
                function (v) { return (v / 100).toFixed(1); }));
            panel.appendChild(self._mkStepper('Letter spacing', 'LetterSpacing', 0, 25, 1,
                function (v) { return (v / 100).toFixed(2) + 'em'; }));
            panel.appendChild(self._mkStepper('Word spacing', 'WordSpacing', 0, 50, 5,
                function (v) { return (v / 100).toFixed(2) + 'em'; }));
            panel.appendChild(self._mkStepper('Paragraph spacing', 'ParaSpacingPct', 100, 300, 25,
                function (v) { return v + '%'; }));
            panel.appendChild(self._mkStepper('Margins', 'MarginPct', 2, 20, 2,
                function (v) { return v + '%'; }));
            panel.appendChild(self._mkChoices('Alignment', 'Align', [
                { value: 'left', label: 'Left' },
                { value: 'justify', label: 'Justified' }
            ]));

            // Theme
            panel.appendChild(self._mkChoices('Theme', 'Theme', [
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'sepia', label: 'Sepia' },
                { value: 'contrast', label: 'High contrast' },
                { value: 'custom', label: 'Custom' }
            ], function (v) { self._syncCustomRow(); }));

            // Custom colors + live contrast readout
            var custom = document.createElement('div');
            custom.id = 'abr-col-custom';
            custom.className = 'abr-col-row';
            custom.setAttribute('role', 'group');
            custom.setAttribute('aria-label', 'Custom colors');
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
                wrap.appendChild(txt);
                wrap.appendChild(inp);
                return wrap;
            }
            custom.appendChild(colorInput('Text color', 'CustomFg'));
            custom.appendChild(colorInput('Background color', 'CustomBg'));
            var ratio = document.createElement('span');
            ratio.id = 'abr-contrast-readout';
            ratio.setAttribute('role', 'status');
            ratio.setAttribute('aria-live', 'polite');
            custom.appendChild(ratio);
            panel.appendChild(custom);

            // Reduced motion
            var motion = document.createElement('div');
            motion.className = 'abr-col-row';
            var motionBtn = document.createElement('button');
            motionBtn.type = 'button';
            motionBtn.className = 'abr-col-choice';
            motionBtn.setAttribute('aria-pressed', self._ds.ReducedMotion ? 'true' : 'false');
            motionBtn.textContent = 'Reduce motion';
            motionBtn.addEventListener('click', function () {
                self._ds.ReducedMotion = !self._ds.ReducedMotion;
                motionBtn.setAttribute('aria-pressed', self._ds.ReducedMotion ? 'true' : 'false');
                self._applyDisplaySettings();
            });
            motion.appendChild(motionBtn);
            panel.appendChild(motion);

            // Initial visibility/readout state
            setTimeout(function () { self._syncCustomRow(); }, 0);
            return panel;
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

        // Resolve a text quote to a block index (TextQuoteSelector-style):
        // the standards fallback that survives edition and layout changes.
        _findByQuote: function (doc, highlight) {
            if (!highlight) return null;
            try {
                var blocks = this._getBlocks(doc);
                for (var i = 0; i < blocks.length; i++) {
                    var t = (blocks[i].textContent || '').replace(/\s+/g, ' ').trim();
                    if (t.indexOf(highlight) !== -1) return i;
                }
            } catch (e) {}
            return null;
        },

        // Block elements that anchor a reading position (layout-independent)
        _getBlocks: function (doc) {
            return doc.body.querySelectorAll(
                'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, dt, dd');
        },

        // Index of the first block on the current page / in the viewport.
        // Paged mode uses offsetLeft (layout geometry — immune to the
        // mid-animation transform); scroll mode uses viewport rects.
        _firstVisiblePara: function () {
            try {
                var frame = document.getElementById('abr-frame');
                var doc = frame.contentDocument;
                var blocks = this._getBlocks(doc);
                var i;
                if (this._viewMode === 'paged') {
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
                if (this._viewMode === 'paged') {
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
            if (this._viewMode === 'paged') {
                return this._pageCount > 1 ? this._page / (this._pageCount - 1) : 0;
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
                        if (self._viewMode === 'paged') {
                            self._goToPage(Math.round(f * (self._pageCount - 1)), true);
                        } else {
                            var max = doc.scrollHeight - doc.clientHeight;
                            if (max > 0 && f > 0) win.scrollTo(0, f * max);
                        }
                    }
                }
                // Debounced save while reading: 2s after scrolling stops
                win.addEventListener('scroll', function () {
                    // Manual scroll while TTS is idle = deliberate move
                    if (!self._ttsPlaying && !self._ttsPaused) self._ttsStartPara = null;
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
