/*
 * AVPlay video player plugin for jellyfin-web.
 *
 * jellyfin-web loads this plugin through `NativeShell.getPlugins()` and the
 * global `AvplayVideoPlayer` factory (see pluginManager.loadPlugin).
 */
(function () {
    'use strict';

    var PLAYER_NAME = 'AVPlay Video Player';
    var PLAYER_ID = 'avplay-video';
    var STATE_IDLE = 'IDLE';
    var STATE_READY = 'READY';
    var STATE_PLAYING = 'PLAYING';
    var STATE_PAUSED = 'PAUSED';

    function hasAvPlay() {
        return typeof webapis !== 'undefined' && !!webapis.avplay;
    }

    function getTizenVersion() {
        var match = navigator.userAgent.match(/Tizen\s+([\d.]+)/i);
        return match ? parseFloat(match[1]) : 0;
    }

    function getProductInfo() {
        try {
            if (typeof webapis !== 'undefined' && webapis.productinfo) {
                return webapis.productinfo;
            }
        } catch (err) {
            console.warn('[AVPlay] productinfo unavailable', err);
        }

        return null;
    }

    function isPanelSupported(name) {
        var productInfo = getProductInfo();

        try {
            return !!productInfo && typeof productInfo[name] === 'function' && productInfo[name]();
        } catch (err) {
            console.warn('[AVPlay] unable to call productinfo.' + name, err);
            return false;
        }
    }

    function is8KPanel() {
        return isPanelSupported('is8KPanelSupported');
    }

    function isUhdPanel() {
        return is8KPanel() || isPanelSupported('isUdPanelSupported');
    }

    function getMaxVideoWidth() {
        if (is8KPanel()) {
            return 7680;
        }

        return isUhdPanel() ? 3840 : 1920;
    }

    function getMaxVideoHeight() {
        if (is8KPanel()) {
            return 4320;
        }

        return isUhdPanel() ? 2160 : 1080;
    }

    function supportsAv1() {
        // AV1 hardware decoding arrived with the 2022 models (Tizen 6.5).
        return getTizenVersion() >= 6.5;
    }

    function getVideoCodecs() {
        var codecs = 'h264,hevc,mpeg2video,vc1,msmpeg4v2,vp8,vp9';

        if (supportsAv1()) {
            codecs += ',av1';
        }

        return codecs;
    }

    function getAudioCodecs() {
        return 'aac,mp3,ac3,eac3,mp2,pcm_s16le,pcm_s24le,aac_latm,opus,flac,vorbis';
    }

    function getRangeCondition() {
        // Samsung TVs support HDR10, HLG and HDR10+ but not Dolby Vision.
        return {
            Condition: 'EqualsAny',
            Property: 'VideoRangeType',
            Value: 'SDR|HDR10|HLG|HDR10Plus',
            IsRequired: false
        };
    }

    function getSizeConditions() {
        var conditions = [];
        var width = getMaxVideoWidth();
        var height = getMaxVideoHeight();

        if (width) {
            conditions.push({
                Condition: 'LessThanEqual',
                Property: 'Width',
                Value: width.toString(),
                IsRequired: false
            });
        }

        if (height) {
            conditions.push({
                Condition: 'LessThanEqual',
                Property: 'Height',
                Value: height.toString(),
                IsRequired: false
            });
        }

        return conditions;
    }

    function buildDeviceProfile() {
        var videoCodecs = getVideoCodecs();
        var audioCodecs = getAudioCodecs();
        var videoConditions = [
            {
                Condition: 'NotEquals',
                Property: 'IsAnamorphic',
                Value: 'true',
                IsRequired: false
            }
        ].concat(getSizeConditions());

        var h264Conditions = videoConditions.concat([
            {
                Condition: 'EqualsAny',
                Property: 'VideoProfile',
                Value: 'high|main|baseline|constrained baseline',
                IsRequired: false
            },
            {
                Condition: 'LessThanEqual',
                Property: 'VideoBitDepth',
                Value: '8',
                IsRequired: false
            },
            {
                Condition: 'LessThanEqual',
                Property: 'VideoLevel',
                Value: '51',
                IsRequired: false
            },
            getRangeCondition()
        ]);

        var hevcConditions = videoConditions.concat([
            {
                Condition: 'EqualsAny',
                Property: 'VideoProfile',
                Value: 'main|main 10',
                IsRequired: false
            },
            {
                Condition: 'LessThanEqual',
                Property: 'VideoBitDepth',
                Value: '10',
                IsRequired: false
            },
            {
                Condition: 'LessThanEqual',
                Property: 'VideoLevel',
                Value: is8KPanel() ? '183' : '156',
                IsRequired: false
            },
            getRangeCondition()
        ]);

        var av1Conditions = videoConditions.concat([
            {
                Condition: 'EqualsAny',
                Property: 'VideoProfile',
                Value: 'main',
                IsRequired: false
            },
            {
                Condition: 'LessThanEqual',
                Property: 'VideoLevel',
                Value: '53',
                IsRequired: false
            },
            getRangeCondition()
        ]);

        var codecProfiles = [
            {
                Type: 'Video',
                Codec: 'h264',
                Conditions: h264Conditions
            },
            {
                Type: 'Video',
                Codec: 'hevc',
                Conditions: hevcConditions
            }
        ];

        if (supportsAv1()) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'av1',
                Conditions: av1Conditions
            });
        }

        var isOldTizen = getTizenVersion() < 6;

        return {
            Name: PLAYER_NAME,
            MaxStreamingBitrate: 140000000,
            MaxStaticBitrate: 140000000,
            MusicStreamingTranscodingBitrate: 384000,

            DirectPlayProfiles: [
                {
                    Container: 'mkv',
                    Type: 'Video',
                    // Tizen 4/5 MKV demuxing is unreliable for H.264. Keep
                    // HEVC direct play (including 4K HDR) and remux H.264 MKV
                    // to HLS TS instead.
                    VideoCodec: isOldTizen ? 'hevc' : videoCodecs,
                    AudioCodec: audioCodecs
                },
                {
                    Container: 'mp4,m4v',
                    Type: 'Video',
                    VideoCodec: videoCodecs,
                    AudioCodec: audioCodecs
                },
                {
                    Container: 'ts,m2ts,mts,trp',
                    Type: 'Video',
                    VideoCodec: videoCodecs,
                    AudioCodec: audioCodecs
                },
                {
                    Container: 'avi',
                    Type: 'Video',
                    VideoCodec: videoCodecs,
                    AudioCodec: audioCodecs
                },
                {
                    Container: 'wmv,asf',
                    Type: 'Video',
                    VideoCodec: videoCodecs,
                    AudioCodec: audioCodecs
                },
                {
                    Container: 'mov',
                    Type: 'Video',
                    VideoCodec: videoCodecs,
                    AudioCodec: audioCodecs
                },
                {
                    Container: 'mpg,mpeg,flv,3gp,vob,vro',
                    Type: 'Video',
                    VideoCodec: videoCodecs,
                    AudioCodec: audioCodecs
                },
                {
                    Container: 'webm',
                    Type: 'Video',
                    VideoCodec: 'vp8,vp9',
                    AudioCodec: 'vorbis,opus'
                },
                {
                    Container: 'opus,mp3,aac,m4a,m4b,flac,webma,wma,wav,ogg',
                    Type: 'Audio'
                }
            ],

            TranscodingProfiles: [
                {
                    Container: 'ts',
                    Type: 'Video',
                    VideoCodec: 'h264,hevc',
                    AudioCodec: 'aac,ac3,eac3,mp3',
                    Protocol: 'hls',
                    Context: 'Streaming',
                    EstimateContentLength: false,
                    EnableMpegtsM2TsMode: false,
                    TranscodeSeekInfo: 'Auto',
                    CopyTimestamps: false,
                    EnableSubtitlesInManifest: false,
                    MaxAudioChannels: '6',
                    MinSegments: 1,
                    SegmentLength: 0,
                    BreakOnNonKeyFrames: false
                },
                {
                    Container: 'aac',
                    Type: 'Audio',
                    AudioCodec: 'aac',
                    Protocol: 'http',
                    Context: 'Streaming',
                    EstimateContentLength: false,
                    TranscodeSeekInfo: 'Auto',
                    CopyTimestamps: false,
                    EnableSubtitlesInManifest: false,
                    MaxAudioChannels: '6',
                    MinSegments: 0,
                    SegmentLength: 0,
                    BreakOnNonKeyFrames: false
                }
            ],

            CodecProfiles: codecProfiles,

            ResponseProfiles: [
                {
                    Container: 'm4v',
                    MimeType: 'video/mp4',
                    Type: 'Video'
                }
            ],

            // The server converts text subtitles to VTT; AVPlay renders the
            // downloaded file. Image subtitles (PGS/VOBSUB) are burned in.
            SubtitleProfiles: [
                {
                    Format: 'vtt',
                    Method: 'External'
                },
                {
                    Format: 'srt',
                    Method: 'External'
                },
                {
                    Format: 'subrip',
                    Method: 'External'
                },
                {
                    Format: 'ass',
                    Method: 'External'
                },
                {
                    Format: 'ssa',
                    Method: 'External'
                },
                {
                    Format: 'mov_text',
                    Method: 'External'
                }
            ]
        };
    }

    function getMediaStreamAudioTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(function (stream) {
            return stream.Type === 'Audio';
        });
    }

    function getMediaStreamTextTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(function (stream) {
            return stream.Type === 'Subtitle';
        });
    }

    function getMediaStreamIndex(streams, streamIndex) {
        for (var i = 0; i < streams.length; i++) {
            if (streams[i].Index === streamIndex) {
                return i;
            }
        }

        return -1;
    }

    function getSubtitleTrack(mediaSource, streamIndex) {
        if (!mediaSource || streamIndex == null || streamIndex < 0) {
            return null;
        }

        var tracks = getMediaStreamTextTracks(mediaSource);

        for (var i = 0; i < tracks.length; i++) {
            if (tracks[i].Index === streamIndex) {
                return tracks[i];
            }
        }

        return null;
    }

    function isExternalTextTrack(track) {
        try {
            var info = JSON.parse(track.extra_info || '{}');
            return !info.track_lang && !info.fourCC;
        } catch (err) {
            return false;
        }
    }

    function parseVttTimestamp(value) {
        var parts = (value || '').trim().split(':');
        var seconds = 0;

        if (parts.length === 3) {
            seconds = parseInt(parts[0], 10) * 3600
                + parseInt(parts[1], 10) * 60
                + parseFloat(parts[2]);
        } else if (parts.length === 2) {
            seconds = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
        }

        return seconds * 1000;
    }

    function parseVtt(text) {
        var cues = [];
        var blocks = (text || '').replace(/\r/g, '').split(/\n\n+/);

        blocks.forEach(function (block) {
            var lines = block.split('\n');
            var timeLine = -1;

            for (var i = 0; i < lines.length; i++) {
                if (lines[i].indexOf('-->') !== -1) {
                    timeLine = i;
                    break;
                }
            }

            if (timeLine < 0) {
                return;
            }

            var range = lines[timeLine].split('-->');
            var start = parseVttTimestamp(range[0]);
            var end = parseVttTimestamp((range[1] || '').trim().split(/\s+/)[0]);
            var textLine = lines.slice(timeLine + 1).join('\n')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .trim();

            if (textLine) {
                cues.push({
                    start: start,
                    end: end,
                    text: textLine
                });
            }
        });

        return cues;
    }

    function isTextSubtitle(track) {
        if (!track) {
            return false;
        }

        var codec = (track.Codec || '').toLowerCase();

        if (codec === 'pgssub' || codec === 'dvdsub' || codec === 'dvbsub' || codec === 'vobsub') {
            return false;
        }

        return track.IsTextSubtitleStream !== false;
    }

    function safeClose() {
        if (!hasAvPlay()) {
            return;
        }

        try {
            if (webapis.avplay.getState() !== STATE_IDLE) {
                webapis.avplay.close();
            }
        } catch (err) {
            console.warn('[AVPlay] close failed', err);
        }
    }

    function safeStop() {
        if (!hasAvPlay()) {
            return;
        }

        try {
            var state = webapis.avplay.getState();

            if (state === STATE_PLAYING || state === STATE_PAUSED) {
                webapis.avplay.stop();
            }
        } catch (err) {
            console.warn('[AVPlay] stop failed', err);
        }
    }

    function AvplayVideoPlayer(modules) {
        var self = this;

        console.debug('[AVPlay] plugin loaded');
        window.__avplayInstance = self;

        self.Events = modules.events;
        self.appRouter = modules.appRouter;
        self.loading = modules.loading;
        self.toast = modules.toast;
        self.ServerConnections = modules.ServerConnections;
        self.playbackManager = modules.playbackManager;

        self.name = PLAYER_NAME;
        self.type = 'mediaplayer';
        self.id = PLAYER_ID;
        self.isLocalPlayer = true;
        self.priority = 0;
        // Ask jellyfin-web 12+ for absolute subtitle URLs; the download API
        // cannot resolve relative paths.
        self.useFullSubtitleUrls = true;

        self._currentPlayOptions = {};
        self._videoElement = null;
        self._currentTrackOffset = 0;
        self._showTrackOffset = false;
        self._ended = false;
        self._destroyed = false;
        self._audioStreamIndex = null;
        self._subtitleStreamIndex = null;
        self._lastCurrentTime = 0;
        self._lastDuration = 0;
        self._subtitleCues = [];

        self.canPlayMediaType = function (mediaType) {
            return hasAvPlay() && (mediaType || '').toLowerCase() === 'video';
        };

        self.supportsPlayMethod = function () {
            return true;
        };

        self.getDeviceProfile = function () {
            return Promise.resolve(buildDeviceProfile());
        };

        self.currentSrc = function () {
            return self._currentPlayOptions.url;
        };

        self.play = function (options) {
            console.log('[AVPlay] play start', options.playMethod);
            self._ended = false;
            self._lastCurrentTime = 0;
            self._lastDuration = 0;
            self._currentPlayOptions = options;
            self._pendingEmbeddedSubtitleIndex = null;

            var defaultSubtitle = getSubtitleTrack(
                options.mediaSource,
                options.mediaSource ? options.mediaSource.DefaultSubtitleStreamIndex : null
            );

            if (defaultSubtitle && isTextSubtitle(defaultSubtitle)) {
                self._subtitleStreamIndex = defaultSubtitle.Index;
                self.loadSubtitleCues(defaultSubtitle, options);
            } else if (defaultSubtitle && defaultSubtitle.DeliveryMethod === 'Embed') {
                self._pendingEmbeddedSubtitleIndex = defaultSubtitle.Index;
            }

            return self.createMediaElement(options)
                .then(function (element) {
                    self._videoElement = element;
                    return self.setCurrentSrc(element, options);
                })
                .then(function () {
                    self.updateDisplayRect();
                    self.addDisplayListeners();

                    try {
                        webapis.avplay.play();
                    } catch (err) {
                        console.error('[AVPlay] play failed', err);
                        throw err;
                    }

                    if (options.playerStartPositionTicks) {
                        // Jellyfin ticks (100 ns) -> milliseconds.
                        return self.currentTime(options.playerStartPositionTicks / 10000)
                            .catch(function (err) {
                                console.warn('[AVPlay] unable to seek to the start position', err);
                            });
                    }

                    return Promise.resolve();
                })
                .then(function () {
                    var audioIndex = options.mediaSource
                        ? options.mediaSource.DefaultAudioStreamIndex
                        : null;
                    var isTranscoding = options.playMethod === 'Transcode';

                    if (!isTranscoding && audioIndex != null && audioIndex >= 0) {
                        self.setAudioStreamIndex(audioIndex);
                    }

                    if (self._pendingEmbeddedSubtitleIndex != null) {
                        self.setSubtitleStreamIndex(self._pendingEmbeddedSubtitleIndex);
                    }

                    self.loading.hide();

                    if (options.fullscreen) {
                        self.showOsdOnPlaybackStart();
                    }

                    return Promise.resolve();
                })
                .then(function () {
                    self.Events.trigger(self, 'playing');
                }, function (err) {
                    self.loading.hide();
                    throw err;
                });
        };

        self.showOsdOnPlaybackStart = function () {
            if (!self.playbackManager || !self.appRouter.showVideoOsd) {
                return;
            }

            var shown = false;

            function showOsd() {
                if (shown) {
                    return;
                }

                shown = true;
                self.Events.off(self.playbackManager, 'playbackstart', showOsd);
                self.appRouter.showVideoOsd();
            }

            // playbackstart fires after playbackmanager has set the current
            // player; showing the OSD earlier makes the video page fail with
            // "player cannot be null".
            self.Events.on(self.playbackManager, 'playbackstart', showOsd);
            setTimeout(showOsd, 1500);
        };

        self.createMediaElement = function (options) {
            var element = document.querySelector('.avplayVideoPlayer');

            if (!element) {
                element = document.createElement('object');
                element.type = 'application/avplayer';
                element.classList.add('avplayVideoPlayer');
                document.body.insertBefore(element, document.body.firstChild);
            }

            if (options.fullscreen) {
                document.body.classList.add('hide-scroll');
            }

            return Promise.resolve(element);
        };

        self.setCurrentSrc = function (element, options) {
            return new Promise(function (resolve, reject) {
                var settled = false;
                var prepareTimer = setTimeout(function () {
                    if (!settled) {
                        settled = true;
                        console.error('[AVPlay] prepare timed out');
                        reject({
                            type: 'PLAYER_ERROR'
                        });
                    }
                }, 30000);

                function finish(error) {
                    if (settled) {
                        return;
                    }

                    settled = true;
                    clearTimeout(prepareTimer);

                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                }

                var listener = {
                    onbufferingstart: function () {
                        console.debug('[AVPlay] buffering start');
                    },

                    onbufferingprogress: function (percent) {
                        console.debug('[AVPlay] buffering ' + percent + '%');
                    },

                    onbufferingcomplete: function () {
                        console.debug('[AVPlay] buffering complete');
                    },

                    onstreamcompleted: function () {
                        console.log('[AVPlay] stream completed');
                        if (self._ended) {
                            return;
                        }

                        self._ended = true;
                        self.onEnded();
                    },

                    oncurrentplaytime: function () {
                        self.updateSubtitleOverlay(self.currentTime());
                        self.Events.trigger(self, 'timeupdate');
                    },

                    onerror: function (eventType) {
                        console.error('[AVPlay] playback error: ' + eventType);

                        if (settled) {
                            self.Events.trigger(self, 'error', [{
                                type: 'MEDIA_DECODE_ERROR'
                            }]);
                        } else {
                            finish({
                                type: 'MEDIA_NOT_SUPPORTED'
                            });
                        }
                    },

                    onevent: function (eventType, eventData) {
                        console.debug('[AVPlay] event ' + eventType + ': ' + eventData);
                    },

                    onsubtitlechange: function (duration, text) {
                        console.debug('[AVPlay] subtitle: ' + text);
                    },

                    ondrmevent: function (drmEvent, drmData) {
                        console.debug('[AVPlay] DRM event ' + drmEvent + ': ' + drmData);
                    }
                };

                try {
                    safeStop();
                    safeClose();

                    webapis.avplay.open(options.url);

                    webapis.avplay.setTimeoutForBuffering(60);
                    webapis.avplay.setListener(listener);

                    if (webapis.avplay.setDisplayMethod) {
                        webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
                    }

                    self.updateDisplayRect();

                    webapis.avplay.prepareAsync(function () {
                        finish();
                    }, function (err) {
                        console.error('[AVPlay] prepare failed', err);
                        finish({
                            type: 'MEDIA_NOT_SUPPORTED'
                        });
                    });
                } catch (err) {
                    console.error('[AVPlay] open failed', err);
                    finish({
                        type: 'MEDIA_NOT_SUPPORTED'
                    });
                }
            });
        };

        self.updateDisplayRect = function () {
            if (!hasAvPlay() || !self._videoElement) {
                return;
            }

            try {
                var rect = self._videoElement.getBoundingClientRect();
                var width = Math.round(rect.width || window.innerWidth);
                var height = Math.round(rect.height || window.innerHeight);

                webapis.avplay.setDisplayRect(
                    Math.round(rect.left || 0),
                    Math.round(rect.top || 0),
                    width,
                    height
                );
            } catch (err) {
                console.warn('[AVPlay] setDisplayRect failed', err);
            }
        };

        var onResize = function () {
            self.updateDisplayRect();
        };

        self.addDisplayListeners = function () {
            window.removeEventListener('resize', onResize);
            window.addEventListener('resize', onResize);
        };

        self.removeDisplayListeners = function () {
            window.removeEventListener('resize', onResize);
        };

        self.stop = function (destroyPlayer) {
            console.log('[AVPlay] stop', destroyPlayer);
            self.clearSubtitle();
            self._lastCurrentTime = self.currentTime();
            self._lastDuration = self.duration();

            if (hasAvPlay()) {
                try {
                    if (webapis.avplay.getState() === STATE_PLAYING) {
                        webapis.avplay.pause();
                    }

                    safeStop();
                    safeClose();
                } catch (err) {
                    console.warn('[AVPlay] stop failed', err);
                }
            }

            if (destroyPlayer) {
                self.destroy();
            }

            if (!self._ended) {
                self._ended = true;
                self.onEnded();
            }

            self._currentPlayOptions = {};

            return Promise.resolve();
        };

        self.destroy = function () {
            self.removeDisplayListeners();
            self.clearSubtitle();

            var subtitleElement = document.querySelector('.avplaySubtitle');

            if (subtitleElement && subtitleElement.parentNode) {
                subtitleElement.parentNode.removeChild(subtitleElement);
            }

            self._destroyed = true;

            if (self._videoElement && self._videoElement.parentNode) {
                self._videoElement.parentNode.removeChild(self._videoElement);
            }

            self._videoElement = null;

            if (hasAvPlay()) {
                safeStop();
                safeClose();
            }

            document.body.classList.remove('hide-scroll');
        };

        self.volume = function () {
            // The TV handles the volume keys itself.
            return 1;
        };

        self.isMuted = function () {
            return false;
        };

        self.setMute = function () {
            // The TV handles mute itself.
            return Promise.resolve();
        };

        self.toggleMute = function () {
            return Promise.resolve();
        };

        self.getAudioStreamIndex = function () {
            return self._audioStreamIndex;
        };

        self.getSubtitleStreamIndex = function () {
            return self._subtitleStreamIndex;
        };

        // jellyfin-web 12 expects the player API in milliseconds.
        self.currentTime = function (milliseconds) {
            if (milliseconds == null) {
                if (!hasAvPlay() || webapis.avplay.getState() === STATE_IDLE) {
                    return self._lastCurrentTime;
                }

                try {
                    return webapis.avplay.getCurrentTime();
                } catch (err) {
                    return self._lastCurrentTime;
                }
            }

            return new Promise(function (resolve, reject) {
                if (!hasAvPlay()) {
                    resolve();
                    return;
                }

                try {
                    webapis.avplay.seekTo(Math.round(milliseconds), function () {
                        self.updateSubtitleOverlay(milliseconds);
                        resolve();
                    }, reject);
                } catch (err) {
                    console.warn('[AVPlay] seek failed', err);
                    reject(err);
                }
            });
        };

        self.duration = function () {
            if (!hasAvPlay() || webapis.avplay.getState() === STATE_IDLE) {
                return self._lastDuration;
            }

            try {
                return webapis.avplay.getDuration();
            } catch (err) {
                return self._lastDuration;
            }
        };

        self.seekable = function () {
            return hasAvPlay() && self.duration() > 0;
        };

        self.paused = function () {
            return hasAvPlay() && webapis.avplay.getState() === STATE_PAUSED;
        };

        self.pause = function () {
            if (!hasAvPlay()) {
                return;
            }

            try {
                if (webapis.avplay.getState() === STATE_PLAYING) {
                    webapis.avplay.pause();
                    self.Events.trigger(self, 'pause');
                }
            } catch (err) {
                console.warn('[AVPlay] pause failed', err);
            }
        };

        self.unpause = function () {
            if (!hasAvPlay()) {
                return;
            }

            try {
                if (webapis.avplay.getState() === STATE_PAUSED) {
                    webapis.avplay.play();
                    self.Events.trigger(self, 'unpause');
                }
            } catch (err) {
                console.warn('[AVPlay] unpause failed', err);
            }
        };

        self.resume = function () {
            self.unpause();
        };

        self.setPlaybackRate = function () {
            return Promise.resolve();
        };

        self.getPlaybackRate = function () {
            return 1;
        };

        self.getSupportedPlaybackRates = function () {
            return [1];
        };

        self.getBufferedRanges = function () {
            // Buffered ranges are reported in Jellyfin ticks (100 ns).
            var currentTime = self.currentTime();
            return currentTime ? [{ start: 0, end: currentTime * 10000 }] : [];
        };

        self.supports = function () {
            return false;
        };

        self.canSetAudioStreamIndex = function () {
            return true;
        };

        self.setAudioStreamIndex = function (streamIndex) {
            if (!hasAvPlay() || streamIndex == null || streamIndex < 0) {
                return;
            }

            var mediaSource = self._currentPlayOptions.mediaSource;

            if (!mediaSource) {
                return;
            }

            self._audioStreamIndex = streamIndex;

            try {
                var audioTracks = getMediaStreamAudioTracks(mediaSource);
                var position = getMediaStreamIndex(audioTracks, streamIndex);

                if (position < 0) {
                    return;
                }

                var avplayTracks = webapis.avplay.getTotalTrackInfo().filter(function (track) {
                    return track.type === 'AUDIO';
                });

                if (position < avplayTracks.length) {
                    webapis.avplay.setSelectTrack('AUDIO', avplayTracks[position].index);
                } else {
                    console.warn('[AVPlay] audio track out of range', streamIndex);
                }
            } catch (err) {
                console.warn('[AVPlay] unable to set audio track', err);
            }
        };

        self.getSubtitleUrl = function (track, options) {
            options = options || self._currentPlayOptions;

            var item = options.item;

            if (!track || !item) {
                return '';
            }

            var apiClient = self.ServerConnections.getApiClient(item.ServerId);
            var subtitleUrl = (track.DeliveryUrl || '').replace(/(\/Stream\.)[a-z0-9]+/i, '$1vtt');
            var url = subtitleUrl.charAt(0) === '/' ? apiClient.getUrl(subtitleUrl) : subtitleUrl;
            var token = apiClient.accessToken && apiClient.accessToken();

            if (token && url.toLowerCase().indexOf('api_key=') === -1 && url.toLowerCase().indexOf('apikey=') === -1) {
                url += (url.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + encodeURIComponent(token);
            }

            return url;
        };

        self.loadSubtitleCues = function (track, options) {
            var url = self.getSubtitleUrl(track, options);

            if (!url) {
                return Promise.resolve();
            }

            return fetch(url).then(function (response) {
                return response.text();
            }).then(function (text) {
                if (self._subtitleStreamIndex !== track.Index) {
                    return;
                }

                self._subtitleCues = parseVtt(text);
                self.updateSubtitleOverlay(self.currentTime());
            }).catch(function (err) {
                console.warn('[AVPlay] unable to load subtitle', err);

                if (self.toast) {
                    self.toast('자막을 불러오지 못했습니다');
                }
            });
        };

        self.ensureSubtitleElement = function () {
            var element = document.querySelector('.avplaySubtitle');

            if (!element) {
                element = document.createElement('div');
                element.className = 'avplaySubtitle';
                document.body.appendChild(element);
            }

            return element;
        };

        self.updateSubtitleOverlay = function (timeMs) {
            if (!self._subtitleCues || !self._subtitleCues.length) {
                return;
            }

            var time = (timeMs || 0) - self._currentTrackOffset;
            var text = '';

            for (var i = 0; i < self._subtitleCues.length; i++) {
                var cue = self._subtitleCues[i];

                if (time >= cue.start && time <= cue.end) {
                    text = cue.text;
                    break;
                }
            }

            var element = self.ensureSubtitleElement();

            if (element.textContent !== text) {
                element.textContent = text;
            }
        };

        self.clearSubtitle = function () {
            self._subtitleCues = [];
            var element = document.querySelector('.avplaySubtitle');

            if (element) {
                element.textContent = '';
            }
        };

        self.setSubtitleStreamIndex = function (streamIndex) {
            self._subtitleStreamIndex = streamIndex;

            if (streamIndex == null || streamIndex < 0) {
                self.clearSubtitle();
                return;
            }

            var mediaSource = self._currentPlayOptions.mediaSource;

            if (!mediaSource) {
                return;
            }

            var track = getSubtitleTrack(mediaSource, streamIndex);

            if (!track) {
                return;
            }

            if (isTextSubtitle(track)) {
                self.clearSubtitle();
                self.loadSubtitleCues(track);
                return;
            }

            if (track.DeliveryMethod === 'Embed' && hasAvPlay()) {
                var textTracks = getMediaStreamTextTracks(mediaSource);
                var position = getMediaStreamIndex(textTracks, streamIndex);

                try {
                    var avplayTracks = webapis.avplay.getTotalTrackInfo().filter(function (avTrack) {
                        return avTrack.type === 'TEXT';
                    });

                    if (position >= 0 && position < avplayTracks.length) {
                        webapis.avplay.setSilentSubtitle(false);
                        webapis.avplay.setSelectTrack('TEXT', avplayTracks[position].index);
                    }
                } catch (err) {
                    console.warn('[AVPlay] unable to set subtitle track', err);
                }
            }
        };

        self.setSecondarySubtitleStreamIndex = function () {
            // AVPlay renders a single subtitle track.
        };

        self.setSubtitleOffset = function (offset) {
            self._currentTrackOffset = Math.round(parseFloat(offset || 0) * 1000);
            self.updateSubtitleOverlay(self.currentTime());
        };

        self.resetSubtitleOffset = function () {
            self._currentTrackOffset = 0;
            self._showTrackOffset = false;
            self.updateSubtitleOverlay(self.currentTime());
        };

        self.enableShowingSubtitleOffset = function () {
            self._showTrackOffset = true;
        };

        self.disableShowingSubtitleOffset = function () {
            self._showTrackOffset = false;
        };

        self.isShowingSubtitleOffsetEnabled = function () {
            return self._showTrackOffset;
        };

        self.getSubtitleOffset = function () {
            return self._currentTrackOffset / 1000;
        };

        self.setAspectRatio = function () {
            return Promise.resolve();
        };

        self.getAspectRatio = function () {
            return 'auto';
        };

        self.getSupportedAspectRatios = function () {
            return ['auto'];
        };

        self.setPictureInPictureEnabled = function () {
            return Promise.resolve();
        };

        self.isPictureInPictureEnabled = function () {
            return false;
        };

        self.isAirPlayEnabled = function () {
            return false;
        };

        self.setAirPlayEnabled = function () {
            return Promise.resolve();
        };

        self.setBrightness = function () {
            return Promise.resolve();
        };

        self.getBrightness = function () {
            return 0;
        };

        self.onEnded = function () {
            console.log('[AVPlay] onEnded');
            self.Events.trigger(self, 'stopped', [{
                src: self.currentSrc()
            }]);
        };
    }

    window.AvplayVideoPlayer = function () {
        return AvplayVideoPlayer;
    };
})();
