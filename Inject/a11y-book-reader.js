'use strict';

if (typeof window.a11yBookReader === 'undefined') {
    window.a11yBookReader = {

        _currentItemId: null,
        _spine: [],
        _chapterIndex: 0,
        _readButtonItem: null,   // the item id the read button was injected for
        _readButton: null,       // reference to the injected button element
        _lastFocused: null,      // element to restore focus to on close

        // ── Initialisation ──────────────────────────────────────────────────

        init: function () {
            this._watchNavigation();
            this._handleCurrentPage();
        },

        _watchNavigation: function () {
            var self = this;
            window.addEventListener('popstate', function () { setTimeout(function () { self._handleCurrentPage(); }, 600); });
            document.addEventListener('viewshow', function () { setTimeout(function () { self._handleCurrentPage(); }, 400); });
            var origPush = history.pushState;
            history.pushState = function () {
                origPush.apply(history, arguments);
                setTimeout(function () { self._handleCurrentPage(); }, 600);
            };
        },

        _handleCurrentPage: function () {
            var self = this;
            var hash = window.location.hash || '';
            var isDetails = hash.includes('/details') || hash.includes('/item');
            if (!isDetails) return;

            var params = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
            var itemId = params.get('id');
            if (!itemId || itemId === self._readButtonItem) return;

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

            self._fetchSpine(itemId).then(function (spine) {
                self._spine = spine;
                self._chapterIndex = 0;
                self._buildReaderDOM(bookName);
                self._loadChapter(0);
            }).catch(function () {
                alert('Could not open this book. Make sure it is an EPUB file.');
            });
        },

        _closeReader: function () {
            var overlay = document.getElementById('abr-overlay');
            if (overlay) overlay.remove();
            document.removeEventListener('keydown', this._keyHandler);
            if (this._lastFocused && this._lastFocused.focus) {
                this._lastFocused.focus();
            }
        },

        // ── DOM Construction ─────────────────────────────────────────────────

        _buildReaderDOM: function (bookName) {
            var self = this;

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
            document.body.appendChild(overlay);

            // Focus management
            this._trapFocus(overlay);
            this._keyHandler = this._onKeyDown.bind(this);
            document.addEventListener('keydown', this._keyHandler);

            // TV focus: stamp show-focus on all buttons inside the reader
            this._tvFocusSweep(overlay);

            // Initial focus
            closeBtn.focus();
        },

        // ── Chapter Navigation ───────────────────────────────────────────────

        _loadChapter: function (index) {
            var self = this;
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
            frame.src = src;

            // Re-apply TV focus after iframe src change
            frame.onload = function () {
                self._tvFocusSweep(document.getElementById('abr-overlay'));
            };
        },

        _navigateChapter: function (delta) {
            this._loadChapter(this._chapterIndex + delta);
        },

        // ── Keyboard & Focus ─────────────────────────────────────────────────

        _onKeyDown: function (e) {
            if (!document.getElementById('abr-overlay')) return;
            if (e.key === 'Escape') { e.preventDefault(); this._closeReader(); return; }
            if (e.key === 'ArrowLeft')  { e.preventDefault(); this._navigateChapter(-1); return; }
            if (e.key === 'ArrowRight') { e.preventDefault(); this._navigateChapter(1);  return; }
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

        // Mirror Jellyfin TV focus pattern from BetterSeerrTabs
        _tvFocusSweep: function (root) {
            if (!document.querySelector('.show-focus')) return;
            root.querySelectorAll('button, iframe, [tabindex="0"]').forEach(function (el) {
                el.classList.add('show-focus');
            });
        },

        // ── API Helpers ──────────────────────────────────────────────────────

        _fetchSpine: function (itemId) {
            return ApiClient.ajax({
                url: ApiClient.getUrl('A11yBookReader/spine/' + itemId),
                type: 'GET',
                dataType: 'json'
            });
        }
    };

    // Boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { window.a11yBookReader.init(); });
    } else {
        window.a11yBookReader.init();
    }
}
