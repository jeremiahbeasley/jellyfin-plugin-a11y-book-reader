'use strict';

if (typeof window.a11yBookReader === 'undefined') {
    window.a11yBookReader = {

        _currentItemId: null,
        _spine: [],
        _chapterIndex: 0,
        _pendingScrollFraction: null,
        _scrollSaveTimer: null,
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
                if (document.getElementById('abr-overlay')) { self._closeReader(true); return; }
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

            self._fetchSpine(itemId).then(function (spine) {
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
                    var ch = p && (typeof p.Chapter === 'number' ? p.Chapter : p.chapter);
                    var fr = p && (typeof p.Fraction === 'number' ? p.Fraction : p.fraction);
                    if (typeof ch !== 'number' || ch < 0 || ch >= spine.length) ch = null;
                    if (typeof fr !== 'number' || fr < 0 || fr > 1) fr = 0;
                    if (ch !== null && (ch > 0 || fr > 0)) {
                        self._pendingScrollFraction = fr;
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
            // Final position save before the overlay (and its iframe) is torn down
            this._saveProgress(this._chapterIndex, this._currentScrollFraction());
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
            ttsBtn.setAttribute('aria-label', 'Read aloud');
            ttsBtn.setAttribute('aria-pressed', 'false');
            ttsBtn.innerHTML = '<span class="material-icons" aria-hidden="true">volume_up</span>';
            ttsBtn.addEventListener('click', function () { self._toggleTts(); });
            toolbar.appendChild(ttsBtn);

            var ttsStopBtn = document.createElement('button');
            ttsStopBtn.id = 'abr-tts-stop';
            ttsStopBtn.type = 'button';
            ttsStopBtn.className = 'abr-icon-btn';
            ttsStopBtn.setAttribute('aria-label', 'Stop reading aloud');
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
                    self._saveSettings();
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
            prevBtn.addEventListener('click', function () { self._navigateChapter(-1); });

            var chapterLabel = document.createElement('span');
            chapterLabel.id = 'abr-chapter-label';
            chapterLabel.className = 'abr-chapter-label';

            var nextBtn = document.createElement('button');
            nextBtn.id = 'abr-next';
            nextBtn.type = 'button';
            nextBtn.className = 'abr-nav-btn';
            nextBtn.setAttribute('aria-label', 'Next chapter');
            nextBtn.innerHTML = 'Next <span class="material-icons" aria-hidden="true">chevron_right</span>';
            nextBtn.addEventListener('click', function () { self._navigateChapter(1); });

            nav.appendChild(prevBtn);
            nav.appendChild(chapterLabel);
            nav.appendChild(nextBtn);

            overlay.appendChild(toolbar);
            overlay.appendChild(contentArea);
            overlay.appendChild(nav);

            // Swipe left = next chapter, swipe right = prev (mobile / TV touchscreen)
            var touchStartX = 0;
            overlay.addEventListener('touchstart', function (e) {
                touchStartX = e.touches[0].clientX;
            }, { passive: true });
            overlay.addEventListener('touchend', function (e) {
                var dx = e.changedTouches[0].clientX - touchStartX;
                if (Math.abs(dx) > 50) {
                    if (dx < 0) self._navigateChapter(1);
                    else self._navigateChapter(-1);
                }
            });

            document.body.appendChild(overlay);

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
            // resume jump (the pending fraction would be clobbered with 0).
            if (self._pendingScrollFraction === null) {
                self._saveProgress(self._chapterIndex, 0);
            }
            frame.src = src;

            frame.onload = function () {
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
            this._loadChapter(this._chapterIndex + delta);
        },

        // ── Keyboard & Focus ─────────────────────────────────────────────────

        _onKeyDown: function (e) {
            var overlay = document.getElementById('abr-overlay');
            if (!overlay) return;

            // Escape and TV back button both close the reader
            if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
                e.preventDefault(); this._closeReader(); return;
            }
            // p = play/pause TTS
            if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this._toggleTts(); return; }

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

        _startTts: function () {
            var self = this;
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
                        'z-index:2147483647;transition:left 80ms,top 80ms,width 80ms;';
                    iframeDoc.body.appendChild(box);
                }
                var sx = iframeWin.pageXOffset || 0;
                var sy = iframeWin.pageYOffset || 0;
                box.style.left = (rect.left + sx - 1) + 'px';
                box.style.top = (rect.top + sy - 1) + 'px';
                box.style.width = (rect.width + 2) + 'px';
                box.style.height = (rect.height + 2) + 'px';
                box.style.display = 'block';

                // Scroll word into view if near edge
                if (entry.node.parentElement) {
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
                toggleBtn.setAttribute('aria-label', 'Pause reading aloud');
                toggleBtn.setAttribute('aria-pressed', 'true');
                toggleBtn.innerHTML = '<span class="material-icons" aria-hidden="true">pause</span>';
                toggleBtn.classList.add('abr-tts-active');
                toggleBtn.classList.remove('abr-tts-paused');
                if (stopBtn) stopBtn.removeAttribute('hidden');
            } else if (this._ttsPaused) {
                toggleBtn.setAttribute('aria-label', 'Resume reading aloud');
                toggleBtn.setAttribute('aria-pressed', 'true');
                toggleBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
                toggleBtn.classList.remove('abr-tts-active');
                toggleBtn.classList.add('abr-tts-paused');
                if (stopBtn) stopBtn.removeAttribute('hidden');
            } else {
                toggleBtn.setAttribute('aria-label', 'Read aloud');
                toggleBtn.setAttribute('aria-pressed', 'false');
                toggleBtn.innerHTML = '<span class="material-icons" aria-hidden="true">volume_up</span>';
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

        _loadSettings: function () {
            try {
                var raw = localStorage.getItem(this._getSettingsKey());
                if (!raw) return;
                var s = JSON.parse(raw);
                if (typeof s.rate === 'number' && s.rate >= 0.5 && s.rate <= 3) this._ttsRate = s.rate;
                if (typeof s.voice === 'string') this._ttsVoiceURI = s.voice;
            } catch (e) {}
        },

        _saveSettings: function () {
            try {
                localStorage.setItem(this._getSettingsKey(), JSON.stringify({
                    rate: this._ttsRate,
                    voice: this._ttsVoiceURI
                }));
            } catch (e) {}
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

        _saveProgress: function (chapter, fraction) {
            if (!this._currentItemId) return;
            try {
                ApiClient.ajax({
                    url: ApiClient.getUrl('A11yBookReader/progress/' + this._currentItemId),
                    type: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({ Chapter: chapter, Fraction: fraction })
                }).catch(function () {});
            } catch (e) {}
        },

        _currentScrollFraction: function () {
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
                // Apply the resume fraction held from _openReader, exactly once
                if (self._pendingScrollFraction !== null) {
                    var f = self._pendingScrollFraction;
                    self._pendingScrollFraction = null;
                    var max = doc.scrollHeight - doc.clientHeight;
                    if (max > 0 && f > 0) win.scrollTo(0, f * max);
                }
                // Debounced save while reading: 2s after scrolling stops
                win.addEventListener('scroll', function () {
                    if (self._scrollSaveTimer) clearTimeout(self._scrollSaveTimer);
                    self._scrollSaveTimer = setTimeout(function () {
                        self._saveProgress(self._chapterIndex, self._currentScrollFraction());
                    }, 2000);
                });
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
