(function () {
    'use strict';

    // Adds a "scan all libraries" button to the TV header and shows the
    // progress of Jellyfin's RefreshLibrary scheduled task. The button is
    // injected by gulpfile.babel.js next to tizen.js, so jellyfin-web itself
    // does not need to be patched.

    var TASK_KEY = 'RefreshLibrary';
    var IDLE_POLL_MS = 5000;
    var ACTIVE_POLL_MS = 2000;
    var START_POLL_MS = 1000;
    var PANEL_POLL_MS = 3000;
    var HIDDEN_POLL_MS = 30000;

    var REFRESH_ICON = '<svg viewBox="0 0 24 24" width="1.35em" height="1.35em" '
        + 'fill="currentColor" aria-hidden="true" focusable="false">'
        + '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6'
        + 'c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

    var strings = getStrings();

    var state = {
        api: null,
        task: null,
        admin: null,
        fetched: false,
        fetching: false,
        starting: false,
        startRequestedAt: 0,
        stopping: false,
        stopRequestedAt: 0,
        panelOpen: false,
        error: null,
        timer: null
    };

    var els = {};
    var floatHost;
    var headerObserver;
    var observedHeader;

    function getStrings() {
        var language = '';

        try {
            language = (navigator.language || navigator.userLanguage || '').toLowerCase();
        } catch (err) {
            // Ignore.
        }

        if (language.indexOf('ko') === 0) {
            return {
                button: '스캔',
                buttonRunning: '스캔 {0}%',
                buttonRunningUnknown: '스캔 중',
                buttonStarting: '시작 중',
                buttonCancelling: '취소 중',
                title: '전체 라이브러리 스캔',
                statusStarting: '스캔을 시작하는 중...',
                statusRunning: '미디어 라이브러리를 스캔하는 중...',
                statusCancelling: '스캔을 취소하는 중...',
                statusCompleted: '마지막 스캔이 완료되었습니다.',
                statusFailed: '마지막 스캔이 실패했습니다.',
                statusCancelled: '마지막 스캔이 취소되었습니다.',
                statusIdle: '스캔 대기 중입니다.',
                statusNever: '아직 스캔 기록이 없습니다.',
                lastRun: '마지막 스캔: {0}',
                lastRunUnknown: '기록 없음',
                scanNow: '지금 스캔',
                cancelScan: '스캔 취소',
                close: '닫기',
                progress: '{0}%',
                errorStart: '스캔을 시작하지 못했습니다.',
                errorStop: '스캔을 취소하지 못했습니다.',
                errorForbidden: '관리자만 라이브러리를 스캔할 수 있습니다.',
                errorNoTask: '라이브러리 스캔 작업을 찾을 수 없습니다.',
                errorNetwork: '서버에 연결할 수 없습니다.'
            };
        }

        return {
            button: 'Scan',
            buttonRunning: 'Scan {0}%',
            buttonRunningUnknown: 'Scanning',
            buttonStarting: 'Starting',
            buttonCancelling: 'Cancelling',
            title: 'Scan All Libraries',
            statusStarting: 'Starting library scan...',
            statusRunning: 'Scanning the media library...',
            statusCancelling: 'Cancelling the library scan...',
            statusCompleted: 'The last scan completed.',
            statusFailed: 'The last scan failed.',
            statusCancelled: 'The last scan was cancelled.',
            statusIdle: 'Ready to scan.',
            statusNever: 'The library has not been scanned yet.',
            lastRun: 'Last scan: {0}',
            lastRunUnknown: 'never',
            scanNow: 'Scan now',
            cancelScan: 'Cancel scan',
            close: 'Close',
            progress: '{0}%',
            errorStart: 'Unable to start the scan.',
            errorStop: 'Unable to cancel the scan.',
            errorForbidden: 'Only administrators can scan the library.',
            errorNoTask: 'The library scan task was not found.',
            errorNetwork: 'Unable to connect to the server.'
        };
    }

    function format(template, value) {
        return String(template).replace('{0}', value);
    }

    function getApi() {
        var api = window.ApiClient;

        if (!api || typeof api.getUrl !== 'function' || typeof api.ajax !== 'function') {
            return null;
        }

        try {
            if (typeof api.isLoggedIn === 'function' && !api.isLoggedIn()) {
                return null;
            }

            if (typeof api.accessToken === 'function' && !api.accessToken()) {
                return null;
            }
        } catch (err) {
            return null;
        }

        return api;
    }

    function taskState(task) {
        return task && task.State ? String(task.State).toLowerCase() : 'idle';
    }

    function isRunning(task) {
        var name = taskState(task);

        return name === 'running' || name === 'cancelling';
    }

    function progressValue(task) {
        if (!task || typeof task.CurrentProgressPercentage !== 'number') {
            return null;
        }

        if (isNaN(task.CurrentProgressPercentage)) {
            return null;
        }

        return Math.max(0, Math.min(100, task.CurrentProgressPercentage));
    }

    function findTask(tasks) {
        if (!tasks || !tasks.length) {
            return null;
        }

        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i] && tasks[i].Key === TASK_KEY) {
                return tasks[i];
            }
        }

        return null;
    }

    function isVisible(element) {
        if (!element || !element.getBoundingClientRect) {
            return false;
        }

        var rect = element.getBoundingClientRect();

        if (!rect.width || !rect.height) {
            return false;
        }

        var style = window.getComputedStyle(element);

        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0';
    }

    function findHeaderRight() {
        var candidates = document.querySelectorAll('.skinHeader .headerRight, .headerRight');

        for (var i = 0; i < candidates.length; i++) {
            if (isVisible(candidates[i])) {
                return candidates[i];
            }
        }

        return null;
    }

    function watchHeader() {
        var header = document.querySelector('.skinHeader');

        if (header === observedHeader) {
            return;
        }

        if (headerObserver) {
            headerObserver.disconnect();
            headerObserver = null;
        }

        observedHeader = header;

        if (!header || typeof MutationObserver === 'undefined') {
            return;
        }

        headerObserver = new MutationObserver(function () {
            attachButton();
        });

        // jellyfin-web redraws the header by replacing its innerHTML. Move the
        // button back as soon as that happens.
        headerObserver.observe(header, { childList: true, subtree: true });
    }

    function attachButton() {
        if (!els.button) {
            return;
        }

        watchHeader();

        var headerRight = findHeaderRight();

        if (headerRight) {
            if (els.button.parentNode !== headerRight) {
                headerRight.insertBefore(els.button, headerRight.firstChild);
            }

            if (floatHost && floatHost.parentNode) {
                floatHost.parentNode.removeChild(floatHost);
            }

            return;
        }

        if (!floatHost) {
            floatHost = document.createElement('div');
            floatHost.className = 'libraryScanFloat';
        }

        if (floatHost.parentNode !== document.body) {
            document.body.appendChild(floatHost);
        }

        if (els.button.parentNode !== floatHost) {
            floatHost.appendChild(els.button);
        }
    }

    function createElements() {
        if (els.button) {
            return;
        }

        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'libraryScanButton';
        button.setAttribute('aria-label', strings.title);
        button.innerHTML = '<span class="libraryScanButtonIcon" aria-hidden="true">'
            + REFRESH_ICON
            + '</span><span class="libraryScanButtonText"></span>';
        button.addEventListener('click', onButtonClick);

        els.button = button;
        els.buttonText = button.querySelector('.libraryScanButtonText');

        var overlay = document.createElement('div');
        overlay.className = 'libraryScanOverlay';
        overlay.hidden = true;
        overlay.innerHTML = '<div class="libraryScanDialog" role="dialog" aria-modal="true" '
            + 'aria-labelledby="libraryScanDialogTitle">'
            + '<div class="libraryScanCard">'
            + '<h2 class="libraryScanTitle" id="libraryScanDialogTitle"></h2>'
            + '<p class="libraryScanStatus" aria-live="polite"></p>'
            + '<div class="libraryScanProgress"><div class="libraryScanProgressFill"></div></div>'
            + '<p class="libraryScanMeta"></p>'
            + '<p class="libraryScanError" hidden></p>'
            + '<div class="libraryScanActions">'
            + '<button type="button" class="libraryScanAction libraryScanActionPrimary"></button>'
            + '<button type="button" class="libraryScanAction libraryScanActionClose"></button>'
            + '</div>'
            + '</div>'
            + '</div>';
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) {
                closePanel();
            }
        });

        document.body.appendChild(overlay);

        els.overlay = overlay;
        els.dialog = overlay.querySelector('.libraryScanDialog');
        els.title = overlay.querySelector('.libraryScanTitle');
        els.status = overlay.querySelector('.libraryScanStatus');
        els.progress = overlay.querySelector('.libraryScanProgress');
        els.progressFill = overlay.querySelector('.libraryScanProgressFill');
        els.meta = overlay.querySelector('.libraryScanMeta');
        els.error = overlay.querySelector('.libraryScanError');
        els.primary = overlay.querySelector('.libraryScanActionPrimary');
        els.close = overlay.querySelector('.libraryScanActionClose');

        els.title.textContent = strings.title;
        els.primary.addEventListener('click', function () {
            if (els.primary.getAttribute('data-action') === 'stop') {
                stopScan();
            } else {
                startScan();
            }
        });
        els.close.addEventListener('click', closePanel);
    }

    function updateVisibility() {
        if (!els.button) {
            return;
        }

        if (!state.admin) {
            els.button.hidden = true;
            return;
        }

        attachButton();
        els.button.hidden = false;
    }

    function renderButton() {
        if (!els.button) {
            return;
        }

        var running = isRunning(state.task);
        var percentage = progressValue(state.task);
        var label;

        els.button.classList.toggle('is-running', running || state.starting);
        els.button.classList.toggle('is-error', !!state.error && !running && !state.starting);

        if (state.starting) {
            label = strings.buttonStarting;
        } else if (state.stopping || taskState(state.task) === 'cancelling') {
            label = strings.buttonCancelling;
        } else if (running) {
            label = percentage === null
                ? strings.buttonRunningUnknown
                : format(strings.buttonRunning, Math.round(percentage));
        } else {
            label = strings.button;
        }

        els.buttonText.textContent = label;
        els.button.setAttribute('aria-label', state.error ? strings.title + ' - ' + state.error
            : strings.title + ' - ' + label);
    }

    function idleStatus(task) {
        var result = task && task.LastExecutionResult;
        var status = result && result.Status ? String(result.Status).toLowerCase() : '';

        if (status === 'completed') {
            return strings.statusCompleted;
        }

        if (status === 'failed') {
            return strings.statusFailed;
        }

        if (status === 'cancelled' || status === 'aborted') {
            return strings.statusCancelled;
        }

        if (result && result.StartTimeUtc) {
            return strings.statusIdle;
        }

        return strings.statusNever;
    }

    function formatLastRun(task) {
        var result = task && task.LastExecutionResult;
        var value = result && (result.EndTimeUtc || result.StartTimeUtc);

        if (!value) {
            return strings.lastRunUnknown;
        }

        var date = new Date(value);

        if (isNaN(date.getTime())) {
            return strings.lastRunUnknown;
        }

        try {
            return date.toLocaleString();
        } catch (err) {
            return date.toISOString();
        }
    }

    function renderPanel() {
        if (!state.panelOpen) {
            return;
        }

        var task = state.task;
        var name = taskState(task);
        var running = isRunning(task);
        var percentage = progressValue(task);
        var progressVisible = running || state.starting || state.stopping;
        var status;
        var meta = [];

        if (state.starting) {
            status = strings.statusStarting;
        } else if (state.stopping || name === 'cancelling') {
            status = strings.statusCancelling;
        } else if (running) {
            status = strings.statusRunning;
        } else {
            status = idleStatus(task);
        }

        els.title.textContent = strings.title;
        els.status.textContent = status;
        els.error.textContent = state.error || '';
        els.error.hidden = !state.error;

        if (progressVisible && percentage !== null) {
            meta.push(format(strings.progress, Math.round(percentage)));
        }

        meta.push(format(strings.lastRun, formatLastRun(task)));
        els.meta.textContent = meta.join(' · ');

        els.progress.hidden = !progressVisible;

        if (progressVisible) {
            if (percentage === null) {
                els.progress.classList.add('is-indeterminate');
                els.progressFill.style.width = '';
            } else {
                els.progress.classList.remove('is-indeterminate');
                els.progressFill.style.width = Math.round(percentage) + '%';
            }
        } else {
            els.progress.classList.remove('is-indeterminate');
            els.progressFill.style.width = '0%';
        }

        var action = 'start';
        var label = strings.scanNow;
        var disabled = false;

        if (!task || !task.Id) {
            action = 'none';
            disabled = true;
        } else if (state.starting) {
            action = 'none';
            label = strings.buttonStarting;
            disabled = true;
        } else if (state.stopping || name === 'cancelling') {
            action = 'none';
            label = strings.buttonCancelling;
            disabled = true;
        } else if (running) {
            action = 'stop';
            label = strings.cancelScan;
        }

        els.primary.setAttribute('data-action', action);
        els.primary.textContent = label;
        els.primary.disabled = disabled;
        els.primary.hidden = action === 'none' && !state.starting && !state.stopping && !running;
        els.primary.classList.toggle('is-danger', action === 'stop');
        els.close.textContent = strings.close;

        // Do not leave focus on a button that just became disabled.
        if (document.activeElement === els.primary && els.primary.disabled) {
            focusElement(els.close);
        }
    }

    function render() {
        if (!els.button) {
            return;
        }

        updateVisibility();
        renderButton();

        if (state.panelOpen) {
            renderPanel();
        }
    }

    function focusElement(element) {
        if (!element) {
            return;
        }

        try {
            element.focus({ preventScroll: true });
        } catch (err) {
            try {
                element.focus();
            } catch (innerErr) {
                // Ignore.
            }
        }
    }

    function focusPanelAction() {
        var target = els.primary && !els.primary.hidden && !els.primary.disabled
            ? els.primary
            : els.close;

        setTimeout(function () {
            focusElement(target);
        }, 0);
    }

    function openPanel() {
        if (state.panelOpen) {
            return;
        }

        state.panelOpen = true;
        els.overlay.hidden = false;
        renderPanel();
        focusPanelAction();
    }

    function closePanel() {
        if (!state.panelOpen) {
            return;
        }

        state.panelOpen = false;
        els.overlay.hidden = true;

        if (els.button && document.contains(els.button)) {
            focusElement(els.button);
        }
    }

    function errorText(error, fallback) {
        if (error && (error.status === 401 || error.status === 403)) {
            return strings.errorForbidden;
        }

        return fallback;
    }

    function startScan() {
        var api = state.api || getApi();
        var task = state.task;

        if (!api || !task || !task.Id) {
            state.error = strings.errorNoTask;
            renderPanel();
            return;
        }

        if (isRunning(task) || state.starting || state.stopping) {
            return;
        }

        state.starting = true;
        state.startRequestedAt = new Date().getTime();
        state.error = null;
        render();

        api.ajax({
            url: api.getUrl('ScheduledTasks/Running/' + task.Id),
            type: 'POST'
        }).then(function () {
            pollNow(250);
        }, function (error) {
            state.starting = false;
            state.error = errorText(error, strings.errorStart);
            render();
        });
    }

    function stopScan() {
        var api = state.api || getApi();
        var task = state.task;

        if (!api || !task || !task.Id) {
            state.error = strings.errorNoTask;
            renderPanel();
            return;
        }

        if (state.stopping) {
            return;
        }

        state.stopping = true;
        state.stopRequestedAt = new Date().getTime();
        state.error = null;
        renderPanel();

        api.ajax({
            url: api.getUrl('ScheduledTasks/Running/' + task.Id),
            type: 'DELETE'
        }).then(function () {
            pollNow(250);
        }, function (error) {
            state.stopping = false;
            state.error = errorText(error, strings.errorStop);
            render();
        });
    }

    function onButtonClick() {
        if (!state.admin) {
            return;
        }

        openPanel();

        if (isRunning(state.task) || state.starting || state.stopping) {
            return;
        }

        startScan();
    }

    function movePanelFocus(direction) {
        var buttons = [];

        if (els.primary && !els.primary.hidden && !els.primary.disabled) {
            buttons.push(els.primary);
        }

        if (els.close && !els.close.hidden && !els.close.disabled) {
            buttons.push(els.close);
        }

        if (!buttons.length) {
            return;
        }

        var current = buttons.indexOf(document.activeElement);
        var next = current === -1
            ? 0
            : (current + direction + buttons.length) % buttons.length;

        focusElement(buttons[next]);
    }

    function onKeyDown(event) {
        if (!state.panelOpen) {
            return;
        }

        var key = event.key || '';
        var code = event.keyCode || event.which;

        if (key === 'Escape' || key === 'Back' || code === 27 || code === 10009 || code === 461) {
            event.preventDefault();
            event.stopPropagation();
            closePanel();
            return;
        }

        if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'ArrowRight' || key === 'ArrowDown'
            || code === 37 || code === 38 || code === 39 || code === 40) {
            event.preventDefault();
            event.stopPropagation();

            var backwards = key === 'ArrowLeft' || key === 'ArrowUp' || code === 37 || code === 38;
            movePanelFocus(backwards ? -1 : 1);
            return;
        }

        if (key === 'Enter' || key === ' ' || code === 13 || code === 32) {
            event.preventDefault();
            event.stopPropagation();

            var active = document.activeElement;

            if (active && typeof active.click === 'function' && !active.disabled) {
                active.click();
            }
        }
    }

    function applyTask(task) {
        state.task = task;

        if (state.starting && isRunning(task)) {
            state.starting = false;
        } else if (state.starting
            && new Date().getTime() - state.startRequestedAt > 5000) {
            state.starting = false;
        }

        if (state.stopping && !isRunning(task)) {
            state.stopping = false;
        } else if (state.stopping
            && new Date().getTime() - state.stopRequestedAt > 8000) {
            state.stopping = false;
        }
    }

    function nextDelay() {
        if (state.starting || state.stopping) {
            return START_POLL_MS;
        }

        if (isRunning(state.task)) {
            return ACTIVE_POLL_MS;
        }

        if (state.panelOpen) {
            return PANEL_POLL_MS;
        }

        if (state.admin === false) {
            return HIDDEN_POLL_MS;
        }

        return IDLE_POLL_MS;
    }

    function schedule(delay) {
        if (state.timer) {
            clearTimeout(state.timer);
        }

        state.timer = setTimeout(poll, delay);
    }

    function pollNow(delay) {
        if (state.timer) {
            clearTimeout(state.timer);
        }

        state.timer = setTimeout(poll, typeof delay === 'number' ? delay : 0);
    }

    function refreshTasks(done) {
        var api = state.api || getApi();

        if (!api || state.fetching) {
            if (done) {
                done();
            }

            return;
        }

        state.fetching = true;

        api.ajax({
            url: api.getUrl('ScheduledTasks'),
            type: 'GET',
            dataType: 'json'
        }).then(function (tasks) {
            state.fetching = false;
            state.fetched = true;
            state.admin = true;
            state.error = null;

            var task = findTask(tasks);

            if (!task) {
                state.task = null;
                state.error = strings.errorNoTask;
            } else {
                applyTask(task);
            }

            render();

            if (done) {
                done();
            }
        }, function (error) {
            state.fetching = false;
            state.fetched = true;

            if (error && (error.status === 401 || error.status === 403)) {
                state.admin = false;
                state.task = null;
                state.error = null;
            } else {
                // Keep a visible button through a temporary network failure.
                if (state.admin !== true) {
                    state.admin = false;
                }

                state.error = strings.errorNetwork;
            }

            render();

            if (done) {
                done();
            }
        });
    }

    function resetForApi(api) {
        state.api = api;
        state.task = null;
        state.admin = null;
        state.fetched = false;
        state.fetching = false;
        state.starting = false;
        state.stopping = false;
        state.error = null;

        render();
    }

    function poll() {
        state.timer = null;

        if (document.hidden) {
            return;
        }

        var api = getApi();

        if (!api) {
            if (state.api) {
                resetForApi(null);
            } else {
                state.admin = null;
                state.fetched = false;
                state.error = null;
                render();
            }

            schedule(3000);
            return;
        }

        if (api !== state.api) {
            resetForApi(api);
        }

        refreshTasks(function () {
            schedule(nextDelay());
        });
    }

    function init() {
        if (!document.body) {
            setTimeout(init, 50);
            return;
        }

        createElements();
        attachButton();

        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
                pollNow(0);
            }
        });
        window.addEventListener('hashchange', function () {
            pollNow(100);
        });
        window.addEventListener('resize', attachButton);

        pollNow(0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
