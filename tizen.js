(function () {
    'use strict';

    console.log('Tizen adapter');

    // Similar to jellyfin-web
    function generateDeviceId() {
        return btoa([navigator.userAgent, new Date().getTime()].join('|')).replace(/=/g, '1');
    }

    function getDeviceId() {
        // Use variable '_deviceId2' to mimic jellyfin-web

        var deviceId = localStorage.getItem('_deviceId2');

        if (!deviceId) {
            deviceId = generateDeviceId();
            localStorage.setItem('_deviceId2', deviceId);
        }

        return deviceId;
    }

    function getModelName() {
        try {
            if (typeof webapis !== 'undefined' && webapis.productinfo
                && typeof webapis.productinfo.getModel === 'function') {
                var model = webapis.productinfo.getModel();

                if (model) {
                    return 'Samsung ' + model;
                }
            }
        } catch (err) {
            console.warn('Unable to read TV model', err);
        }

        return 'Samsung Smart TV';
    }

    function getAppVersion() {
        try {
            return tizen.application.getCurrentApplication().appInfo.version;
        } catch (err) {
            console.warn('Unable to read app version', err);
            return '0.3.5';
        }
    }

    var AppInfo = {
        deviceId: getDeviceId(),
        deviceName: getModelName(),
        appName: 'Jellyfin for Tizen',
        appVersion: getAppVersion()
    };

    // List of supported features
    var SupportedFeatures = [
        'exit',
        'exitmenu',
        'externallinkdisplay',
        'htmlaudioautoplay',
        'htmlvideoautoplay',
        'physicalvolumecontrol',
        'displaylanguage',
        'otherapppromotions',
        'targetblank',
        'screensaver',
        'multiserver',
        'subtitleappearancesettings',
        'subtitleburnsettings',
        'displaymode'
    ];

    var systeminfo;

    function getProductInfo() {
        try {
            if (typeof webapis !== 'undefined' && webapis.productinfo) {
                return webapis.productinfo;
            }
        } catch (err) {
            console.warn('Unable to access productinfo', err);
        }

        return null;
    }

    function isPanelSupported(name) {
        var productInfo = getProductInfo();

        try {
            return !!productInfo && typeof productInfo[name] === 'function' && productInfo[name]();
        } catch (err) {
            console.warn('Unable to call productinfo.' + name, err);
            return false;
        }
    }

    function getSystemInfo() {
        if (systeminfo) {
            return Promise.resolve(systeminfo);
        }

        return new Promise(function (resolve) {
            function resolveDisplay(result) {
                var devicePixelRatio = 1;

                if (isPanelSupported('is8KPanelSupported')) {
                    console.log('8K UHD is supported');
                    devicePixelRatio = 4;
                } else if (isPanelSupported('isUdPanelSupported')) {
                    console.log('4K UHD is supported');
                    devicePixelRatio = 2;
                } else {
                    console.log('UHD is not supported');
                }

                systeminfo = Object.assign({}, result, {
                    resolutionWidth: Math.floor(result.resolutionWidth * devicePixelRatio),
                    resolutionHeight: Math.floor(result.resolutionHeight * devicePixelRatio)
                });

                resolve(systeminfo);
            }

            try {
                tizen.systeminfo.getPropertyValue('DISPLAY', resolveDisplay, function (err) {
                    console.warn('Unable to read display information', err);
                    resolveDisplay({ resolutionWidth: 1920, resolutionHeight: 1080 });
                });
            } catch (err) {
                console.warn('Unable to read display information', err);
                resolveDisplay({ resolutionWidth: 1920, resolutionHeight: 1080 });
            }
        });
    }

    var screenLocked = false;
    var screenWanted = false;

    function requestScreenLock() {
        if (screenLocked || typeof tizen.power === 'undefined') {
            return;
        }

        try {
            tizen.power.request('SCREEN', 'SCREEN_NORMAL');
            screenLocked = true;
        } catch (err) {
            console.warn('Unable to keep the screen awake', err);
        }
    }

    function releaseScreenLock() {
        if (!screenLocked || typeof tizen.power === 'undefined') {
            return;
        }

        try {
            tizen.power.release('SCREEN');
        } catch (err) {
            console.warn('Unable to release the screen lock', err);
        } finally {
            screenLocked = false;
        }
    }

    function keepScreenAwake() {
        screenWanted = true;
        requestScreenLock();
    }

    function releaseScreen() {
        screenWanted = false;
        releaseScreenLock();
    }

    function postMessage() {
        console.log.apply(console, arguments);
    }

    window.NativeShell = {
        AppHost: {
            init: function () {
                postMessage('AppHost.init', AppInfo);
                return getSystemInfo().then(function () {
                    return Promise.resolve(AppInfo);
                });
            },

            appName: function () {
                postMessage('AppHost.appName', AppInfo.appName);
                return AppInfo.appName;
            },

            appVersion: function () {
                postMessage('AppHost.appVersion', AppInfo.appVersion);
                return AppInfo.appVersion;
            },

            deviceId: function () {
                postMessage('AppHost.deviceId', AppInfo.deviceId);
                return AppInfo.deviceId;
            },

            deviceName: function () {
                postMessage('AppHost.deviceName', AppInfo.deviceName);
                return AppInfo.deviceName;
            },

            exit: function () {
                postMessage('AppHost.exit');
                tizen.application.getCurrentApplication().exit();
            },

            getDefaultLayout: function () {
                postMessage('AppHost.getDefaultLayout', 'tv');
                return 'tv';
            },

            getDeviceProfile: function (profileBuilder) {
                postMessage('AppHost.getDeviceProfile');
                // Used by the HTML5 player (music, photos, AVPlay fallback).
                return profileBuilder({ enableSsaRender: true });
            },

            getSyncProfile: function (profileBuilder) {
                postMessage('AppHost.getSyncProfile');
                return profileBuilder({});
            },

            screen: function () {
                return systeminfo ? {
                    width: systeminfo.resolutionWidth,
                    height: systeminfo.resolutionHeight
                } : null;
            },

            supports: function (command) {
                var isSupported = command && SupportedFeatures.indexOf(command.toLowerCase()) != -1;
                postMessage('AppHost.supports', {
                    command: command,
                    isSupported: isSupported
                });
                return isSupported;
            }
        },

        downloadFile: function (url) {
            postMessage('downloadFile', { url: url });
        },

        enableFullscreen: function () {
            postMessage('enableFullscreen');
            keepScreenAwake();
        },

        disableFullscreen: function () {
            postMessage('disableFullscreen');
            releaseScreen();
        },

        getPlugins: function () {
            postMessage('getPlugins');
            return ['AvplayVideoPlayer'];
        },

        openUrl: function (url, target) {
            postMessage('openUrl', {
                url: url,
                target: target
            });
        },

        updateMediaSession: function (mediaInfo) {
            postMessage('updateMediaSession', { mediaInfo: mediaInfo });
            keepScreenAwake();
        },

        hideMediaSession: function () {
            postMessage('hideMediaSession');
            releaseScreen();
        }
    };

    function registerKey(key) {
        try {
            if (tizen.tvinputdevice) {
                tizen.tvinputdevice.registerKey(key);
            }
        } catch (err) {
            console.warn('Unable to register key ' + key, err);
        }
    }

    function unregisterKey(key) {
        try {
            if (tizen.tvinputdevice) {
                tizen.tvinputdevice.unregisterKey(key);
            }
        } catch (err) {
            console.warn('Unable to unregister key ' + key, err);
        }
    }

    var mediaKeys = [
        'MediaPlay',
        'MediaPause',
        'MediaStop',
        'MediaTrackPrevious',
        'MediaTrackNext',
        'MediaRewind',
        'MediaFastForward'
    ];

    function updateKeys() {
        var inPlayback = location.hash.indexOf('/queue') !== -1
            || location.hash.indexOf('/video') !== -1
            || location.hash.indexOf('/playback') !== -1;

        if (inPlayback) {
            // Handle play/pause in the web player
            registerKey('MediaPlayPause');
        } else {
            unregisterKey('MediaPlayPause');
        }
    }

    window.addEventListener('load', function () {
        mediaKeys.forEach(registerKey);
        updateKeys();
    });

    window.addEventListener('viewshow', updateKeys);
    window.addEventListener('hashchange', updateKeys);

    // Don't keep the screen awake while the app is in the background
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            releaseScreenLock();
        } else if (screenWanted) {
            requestScreenLock();
        }
    });

    window.addEventListener('beforeunload', releaseScreen);
})();
