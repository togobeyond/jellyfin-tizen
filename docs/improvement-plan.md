# jellyfin-tizen 개선 분석 리포트

작성일: 2026-10-25
대상: `togobeyond/jellyfin-tizen` (upstream `jellyfin/jellyfin-tizen` master)
검증 환경: Samsung 2018 QLED (Tizen 4.0), Jellyfin Server 12.3.0, jellyfin-web `release-12.z`
목표: 재생 성능·코덱 호환성 개선 + 리모컨/UX 개선 + 실제 Samsung TV 반영

---

## 1. 요약 (TL;DR)

1. **현재 앱은 AVPlay를 쓰지 않는다.** `tizen.js`는 `NativeShell`만 제공하고
   `getPlugins()`가 빈 배열이라, 모든 영상은 jellyfin-web의 HTML5 `<video>`로 재생된다.
   → 4K HEVC/HDR, MKV, TrueHD/DTS, PGS 자막에서 트랜스코딩·재생 실패·화질 저하가 발생한다.
2. **기기 프로필이 실제 TV 성능과 어긋난다.** jellyfin-web 10.10은 Tizen을 무조건
   MKV/HEVC/AV1 지원으로 광고한다(`browserDeviceProfile.js`). 모델·연도별 디코더 차이를
   반영하지 못해 "지원한다고 광고 → 재생 실패" 또는 "불필요한 트랜스코딩"이 생긴다.
3. **가장 큰 개선 효과는 AVPlay 네이티브 플레이어 플러그인**이다. jellyfin-web을 수정하지 않고
   `NativeShell.getPlugins()` + 전역 플러그인 주입만으로 붙일 수 있어 upstream 동기화 비용이 낮다.
4. **UX는 즉시 개선 가능한 저위험 항목이 많다.** 모델명 표시, 전원/화면 유지, 앱 전환 시 일시정지,
   리모컨 키 안전 등록, 미디어 세션 등.
5. **배포 환경은 이미 절반 준비되어 있다.** 로컬에 Tizen CLI와 서명 인증서가 있고,
   `free-my-tv/tizen/install.py`(SDB 직접 구현, Tizen Studio/sdb 불필요)를 재사용해 TV에 설치할 수 있다.
   단, TV IP·개발자 모드·TV 모델 정보가 아직 확인되지 않았다.

### 구현 현황 (2026-10-25)

이 리포트 작성과 함께 아래 항목을 1차 구현했다. 빌드와 패키징은 로컬에서 검증했고,
실제 TV(Samsung 2018 QLED)에 0.3.7로 설치까지 완료했고, 재생 검증을 진행 중이다.

- [x] `NativeShell.getPlugins()` + `window.AvplayVideoPlayer` 전역 플러그인 구조
- [x] AVPlay 재생/일시정지/탐색/정지/종료, 버퍼링·완료·에러 이벤트 연결
- [x] AVPlay 기반 디바이스 프로필(컨테이너/코덱/HDR/해상도/자막) 생성
- [x] 오디오 트랙 전환, 외부 자막 다운로드(VTT 변환) + 오프셋
- [x] 기기명을 TV 모델명으로 표시
- [x] 리모컨 키 안전 등록, 재생 화면 진입/이탈 시 키 갱신
- [x] 재생 중 화면 유지(`tizen.power`), 앱 전환 시 락 해제
- [x] 디스플레이 정보 조회 실패 시 기본값 폴백
- [x] 빌드/패키징 재현 절차 문서화 → [build-and-deploy.md](build-and-deploy.md)
- [x] Tizen Studio 없이 설치하는 `tools/install.py` 추가

### 실기 피드백 반영 (0.2.2 / 0.2.3)

- Samsung 2018 QLED / Tizen 4.0 / Server 12.3.0에서 **Direct Play 성공** 확인
- 탐색(FF/프로그레스 바)이 동작하지 않는 문제 수정 (0.2.2)
  - 원인: jellyfin-web 12.x의 네이티브 플레이어 API는 `currentTime()`/`duration()`을
    **밀리초**로 주고받는데, 10.x 기준(초)으로 구현되어 있었음
  - 수정: `currentTime`/`duration`을 ms 기준으로 변경, 시작 위치·버퍼 범위(ticks) 변환 수정
- 10-bit HEVC MKV에서 초록/보라色 깨짐 + 내장 ASS/SRT 자막 미표시 (0.2.3 이후)
  - 디바이스 프로필에서 `VideoRangeType=Unknown` direct play 제거 (Dolby Vision 오판 방지)
  - H.264는 8-bit, HEVC는 10-bit까지만 direct play 허용
  - 내장 ASS/SSA/SRT 자막을 **External VTT로 변환**해 재생 전에 다운로드하고,
    `prepare()` 이전에 `setExternalSubtitlePath()` 적용
  - **외부 자막은 `setSelectTrack('TEXT', index)`로 명시 선택해야 실제 표시됨** (0.2.6)
  - 자막 다운로드 실패 시 TV에 토스트 표시

### 버퍼링 원인 (0.2.7)

- TV가 같은 LAN에 있는데도 서버의 **공인 주소(Cloudflare)** 로 접속하고 있었음
- TV에서 LAN 서버(`http://<server-lan-ip>:8096`)까지 실측 **134 Mbps**, 공인 경로는 지연/끊김 발생
- 저장된 서버 주소를 LAN으로 변경: `ManualAddress`/`LocalAddress` = `http://<server-lan-ip>:8096`
- 외부 접속용 주소는 `RemoteAddress`로 유지
- 이 설정은 앱 데이터에 저장되므로 업데이트 후에도 유지됨

### 재생 즉시 중단 원인 (0.3.1)

- AVPlay 플러그인이 `play()` 안에서 `appRouter.showVideoOsd()`를 먼저 호출
- video OSD의 `viewshow`가 `playbackManager.getCurrentPlayer()`보다 먼저 실행됨
- `Error: player cannot be null` → video OSD가 홈으로 이동 → `viewbeforehide`가 재생 중지
- 수정: `playbackstart` 이벤트(플레이어 등록 완료) 이후에 OSD를 표시
- 결과: 첫 재생부터 OSD/재생/자막이 정상 유지됨

### 자막 렌더링 + Direct Play 유지 (0.3.4 / 0.3.5)

- 증상: MKV 재생 시 자막이 안 나오고, 2초 재생 후 멈춤/재개 반복
- 원인 1: 재생 OSD가 플레이어 등록 전에 열려 `player cannot be null` → 홈 이동/중지 (0.3.1)
- 원인 2: AVPlay의 외부 자막 트랙은 자동 표시되지 않거나 HLS에서 노출되지 않음
- 수정:
  - 자막은 AVPlay에 맡기지 않고 **플러그인이 VTT를 fetch/파싱해 DOM 오버레이로 렌더링**
    → Direct Play / HLS 모두에서 동작
  - 자막 오프셋/트랙 전환도 DOM 렌더러에 반영
  - 0.3.4에서는 MKV를 HLS TS로 remux했지만, **0.3.5에서 MKV Direct Play를 다시 허용**
    (OSD 수정 후 실제 TV에서 Direct Play가 정상 동작하는 것을 확인)
- 실기 확인 (Samsung 2018 QLED):
  - 1080p HEVC SDR MKV: Direct Play, 40초 이상 끊김 없음
  - 4K HEVC HDR10 MKV: Direct Play, `TranscodingInfo = null`
  - 외부 한국어 자막: VTT 파싱 후 DOM 오버레이로 표시
- HLS remux는 서버가 Direct Play를 지원하지 않는 파일에 대한 fallback으로 사용
- 0.3.7: Tizen 4/5에서 **H.264 MKV는 HLS TS로 remux**하고, **HEVC MKV(4K HDR 포함)는 Direct Play** 유지
  - H.264 MKV progressive 재생에서 간헐적 멈춤이 보고됨
  - HLS remux는 `IsVideoDirect=true`, `IsAudioDirect=true` (컨테이너만 변경)

---

## 2. 현재 상태 진단

### 2.1 저장소 / 빌드 구조

| 항목 | 상태 |
| --- | --- |
| 브랜치 | `master` = upstream과 동일 (fork 이후 커밋 없음) |
| 앱 셸 | `tizen.js` (NativeShell shim) + jellyfin-web `dist/` |
| 주입 | `gulpfile.babel.js`가 `tizen.js`, `$WEBAPIS/webapis/webapis.js`, CSP를 `index.html`에 삽입 |
| 웹 | jellyfin-web `release-12.z` (12.3.0, 서버 12.3과 일치) |
| 패키징 | `config.xml` 1개, `icon.png`, `www/` |
| 버전 | `0.1.0` (config.xml과 package.json) |

`tizen.js`는 10.8 시절 코드가 일부 남아 있다. 예를 들어
`enableMkvProgressive` 옵션은 10.10의 `browserDeviceProfile.js`에서 더 이상 읽지 않는다(dead option).

### 2.2 재생 경로

```
jellyfin-web playbackmanager
  └─ pluginManager: htmlVideoPlayer (priority 1)  ← 현재 유일한 영상 플레이어
       └─ <video> (Tizen Web Engine HTML5 media)
```

- 네이티브 플레이어 훅은 이미 존재한다:
  - `src/index.jsx:157` — `list.concat(window.NativeShell.getPlugins())`
  - `src/components/pluginManager.js:63` — `window[pluginName]` 전역 함수가 클래스를 반환하면 로드
  - `src/components/playback/playbackmanager.js:1353` — 플레이어의 `getDeviceProfile()` 사용
  - `src/plugins/htmlVideoPlayer/plugin.js:188` — `priority = 1` (플러그인 기본값 0이 우선)
- 따라서 **jellyfin-web 소스 수정 없이** `tizen.js` + `avplayVideoPlayer.js` 주입만으로 AVPlay를 붙일 수 있다.

### 2.3 Tizen 처리의 한계

| 영역 | 현재 코드 | 문제 |
| --- | --- | --- |
| 플러그인 | `tizen.js:161` `getPlugins() { return []; }` | AVPlay 사용 불가 |
| 프로필 | `tizen.js:122` `profileBuilder({ enableMkvProgressive:false, enableSsaRender:true })` | 옵션 일부 dead, 모델별 코덱 미반영 |
| 기기명 | `tizen.js:26` `deviceName: 'Samsung Smart TV'` | 같은 서버에 TV 여러 대면 구분 불가 |
| 리모컨 | `tizen.js:182` 로드 시 미디어 키 등록, `:192` `viewshow`에서 `MediaPlayPause` 토글 | `viewshow`가 영상 화면에서 안 뜰 수 있음, try/catch 없음 |
| 전원 | 없음 | 재생 중 TV 절전/화면 보호기 동작 가능 |
| 생명주기 | 없음 | 홈으로 나갔다 왔을 때 재생 상태/일시정지 처리 없음 |
| 미디어 세션 | `updateMediaSession` 로그만 출력 | TV/외부 리모컨의 now-playing 연동 없음 |
| 네트워크 | 없음 | 서버 끊김 시 사용자 피드백 없음 |

### 2.4 기기 프로필 불일치 (핵심)

`jellyfin-web/src/scripts/browserDeviceProfile.js`:

```js
// 10행: Tizen이면 무조건 HEVC 지원
if (browser.tizen || browser.xboxOne || browser.web0s || options.supportsHevc) return true;

// 24행: Tizen 5.5+면 AV1 지원으로 간주
if (browser.tizenVersion >= 5.5 || ...) return true;

// 204행: Tizen이면 MKV 지원으로 간주
if (browser.tizen || browser.web0s) return true;
```

문제:

- 2018~2019년 일부 모델은 HEVC 10bit/HDR 조합에서 실패한다(upstream #286).
- 4K HEVC HDR MKV가 HTML5 경로에서 트랜스코딩되거나 재생되지 않는다(#163).
- PGS 자막을 켜면 영상 전체가 트랜스코딩되고 HDR이 SDR로 떨어진다(#202).
- TrueHD/DTS-HD는 TV가 디코딩하지 못해 무음/행업이 발생한다(#90).
- AV1은 2022년 이후 모델에서만 HW 지원이 일반적이라 `tizenVersion >= 5.5` 일괄 처리는 위험하다.

### 2.5 배포 환경

| 항목 | 상태 |
| --- | --- |
| Tizen CLI | `~/tizen-studio/tools/ide/bin/tizen` 2.5.25 (PATH 미등록) |
| TV 확장 | TV platform/에뮬레이터 패키지 미설치, `sdb` 없음 |
| 서명 | `~/share/.tizen-cert`에 public distributor/author 인증서 존재, `~/tizen-studio-data/keystore/author/author.p12` 존재 |
| 설치 | `free-my-tv/tizen/install.py`가 SDB 프로토콜(26101)로 WGT 설치 가능 → 재사용 권장 |
| 웹 빌드 | Node 24로 `npm ci` + `build:production` 완료 |
| WGT 빌드 | `tizen build-web` + `tizen package` 완료 (10MB, `jellyfin-tv` 프로필 서명) |

> Tizen Studio의 `sdb`는 Apple Silicon에서 Intel 바이너리라 동작하지 않는 경우가 있다.
> free-my-tv의 Python 설치 스크립트를 그대로 쓰는 편이 안전하다.

---

## 3. 개선 설계

### 3.1 P0 — AVPlay 네이티브 플레이어 (최대 효과)

**구조**

```
tizen.js
  ├─ getPlugins() → ['AvplayVideoPlayer']
  └─ AvplayVideoPlayer (window 전역, pluginManager가 로드)

avplayVideoPlayer.js
  ├─ getDeviceProfile()   ← TV 모델/패널/Tizen 버전 기반 정확한 프로필
  ├─ play/stop/destroy
  ├─ currentTime/duration/seekable/pause/unpause
  ├─ setAudioStreamIndex / setSubtitleStreamIndex
  ├─ getBufferedRanges, getTextTracks, subtitle offset
  └─ AVPlay 이벤트 → jellyfin Events (playing/pause/timeupdate/stopped)
```

**핵심 구현 포인트**

1. `<object type="application/avplayer">`를 화면에 배치하고 `setDisplayRect()`로 크기 동기화.
2. OSD/자막/스킵 버튼이 영상 위에 보이도록 레이어 순서 관리(`tizen.css`).
3. AVPlay 콜백:
   - `onbufferingstart/progress/complete` → 로딩 인디케이터
   - `oncurrentplaytime` → `timeupdate`
   - `onstreamcompleted` → `stopped`
   - `onerror` → jellyfin 에러 UI + HTML5 폴백
4. 오디오 트랙: jellyfin `MediaStreams.Index` ↔ AVPlay `getTotalTrackInfo()`의 AUDIO index 매핑.
5. 자막:
   - 컨테이너 내장 자막: `setSelectTrack('TEXT', index)`
   - 외부 자막: `tizen.download` → `wgt-private-tmp` 다운로드 → `setExternalSubtitlePath()`
   - 오프셋: `setSubtitlePosition(ms)`
6. 탐색: `seekTo(ms)` + 성공/실패 콜백, 탐색 중 OSD 유지.
7. 폴백: AVPlay 초기화 실패/DRM/비정상 컨테이너는 HTML5 플레이어로 자동 전환.

**정확한 디바이스 프로필**

- 패널: `webapis.productinfo.is8KPanelSupported()`, `isUdPanelSupported()`
- 모델: `webapis.productinfo.getModel()`, 펌웨어: `getFirmware()`
- Tizen: `tizen.systeminfo.getPropertyValue('BUILD')` / UA
- 프로필 예시:
  - Container: `mkv,mp4,m4v,ts,m2ts,webm,avi,wmv,...`
  - Video: H.264 ≤ L5.1, HEVC ≤ L5.2(Main10), VP9, (모델 지원 시) AV1
  - Audio: AAC/MP3/AC3/EAC3/FLAC/Opus 기본, TrueHD/DTS는 "패스스루 설정"일 때만
  - HDR: HDR10/HLG는 패널 지원 시, Dolby Vision은 모델별 조건부
  - MaxResolution: 4K/8K 패널에 맞게
  - Subtitle: 내장 + 외부 VTT/SRT 정책, PGS는 번인 또는 미지원 처리
- jellyfin-web의 Tizen 일괄 가정(HEVC/MKV/AV1)을 **네이티브 프로필로 덮어쓴다.**

**예상 효과**

| 시나리오 | 현재 | AVPlay 적용 후 |
| --- | --- | --- |
| 4K HEVC HDR10 MKV | 트랜스코딩/실패 빈번 | Direct Play, HDR 유지 |
| TrueHD/DTS-HD | 무음/행업/오디오 트랜스코딩 | eARC 패스스루 또는 자동 AC3 변환 |
| PGS 자막 | 영상 전체 트랜스코딩 | 정책에 따라 자막만 처리 |
| 탐색 | 서버 트랜스코딩 구간 지연 | 로컬 seek, 즉시 반응 |
| CPU/발열 | WebView 디코딩 부담 | HW 디코더 사용 |

**리스크**

- AVPlay는 DOM이 아닌 별도 플레인 → OSD/자막/애니메이션 겹침 이슈. 실기 튜닝 필요.
- 에뮬레이터에서 AVPlay 동작이 제한적일 수 있음 → 실제 TV 검증 필수.
- 오디오 트랙 인덱스 매핑, 외부 자막 다운로드 실패 처리 등 엣지 케이스.
- 라이선스: `dmitrylyzo/jellyfin-tizen` avplay 브랜치는 MPL-2.0. 코드 재사용 시 출처 표기 + 동일 라이선스 유지.
  (Moonfin/Litefin 등은 라이선스 확인 후 참고만)

### 3.2 P1 — 리모컨 / UX / TV 생명주기

| 항목 | 개선 내용 |
| --- | --- |
| 기기명 | `webapis.productinfo.getModel()` 기반 `"Samsung QN65Q80B"` 형태로 표시, 서버에서 TV 구분 가능 |
| 키 등록 | 모든 `registerKey`를 try/catch로 감싸고, `MediaPlayPause`를 전역 등록. 중복 keydown 방지 |
| 재생 키 | 재생/일시정지/정지/탐색 키를 AVPlay 상태와 동기화 |
| 화면 유지 | 재생 중 `tizen.power.request('SCREEN', 'SCREEN_NORMAL')`, 정지/이탈 시 release |
| 앱 전환 | `visibilitychange`/`tizen.application` 이벤트에서 일시정지, 복귀 시 OSD만 표시 |
| 종료 | 루트에서 Back → 확인창(이미 web에 존재), 재생 중 Back → OSD 닫기 |
| 네트워크 | 오프라인/서버 끊김 감지 시 토스트 + 재연결 안내 |
| 미디어 세션 | `updateMediaSession`을 Tizen 미디어 컨트롤과 연동(가능한 범위) |
| 시작 화면 | 앱 초기화 전 흰 화면 대신 스플래시/로딩 유지 |
| 디버깅 | Web Inspector 연결 가이드, `console` 로그 레벨 정리 |

### 3.3 P2 — 자막 / HDR / 오디오 고도화

- **ASS/SSA**: jellyfin-web은 WASM/캔버스 렌더링(`htmlVideoPlayer.js:1266`)을 사용 → TV에서 CPU 부담.
  AVPlay 내장 자막 또는 서버 VTT 변환 중 선택. 스타일 손실 vs 성능 트레이드오프 문서화.
- **PGS**: 이미지 자막은 텍스트 변환 불가 → 번인(서버 부하) 또는 "PGS는 끄기" UX 제공.
- **HDR**: HDR10/HLG는 패널 지원 시 Direct Play, Dolby Vision은 프로필 7/8 케이스별 조건 추가.
- **오디오 패스스루**: eARC/AVR 연결 시 TrueHD/DTS-HD Direct Play 옵션(기본은 안전하게 AC3/EAC3).
- **자막 싱크**: `setSubtitlePosition`과 jellyfin offset UI 연결.

### 3.4 P3 — 빌드/배포 자동화

- `scripts/build.sh`: Node 버전 확인 → jellyfin-web 빌드(USE_SYSTEM_FONTS=1) → gulp → WGT.
- `scripts/sign.sh`: `~/share/.tizen-cert` 기반 프로필 등록 + `tizen package -s`.
- `scripts/install.py`: free-my-tv의 SDB 설치 스크립트를 WGT 경로 인자화.
- 버전 단일화: `config.xml`/`package.json`/UI 버전을 한 곳에서 관리.
- GitHub Actions: 웹 빌드 캐시 + WGT 아티팩트(서명은 릴리스 시 수동).
- upstream 동기화: 변경을 `tizen.js`, `avplayVideoPlayer.js`, `tizen.css`, `docs/`로 한정.

---

## 4. 작업 순서 (제안)

| 단계 | 내용 | 예상 | 검증 |
| --- | --- | --- | --- |
| 0 | TV/서버 정보 확인, 개발자 모드 연결, 기준 빌드 설치 | 0.5일 | 앱 실행/로그인/재생 |
| 1 | AVPlay 플러그인 MVP (재생·탐색·일시정지·종료) | 1.5~2일 | 1080p/4K MKV Direct Play |
| 2 | 정확한 device profile + 오디오/자막 트랙 전환 | 1일 | 트랜스코딩 사유 확인, 트랙 전환 |
| 3 | OSD 레이어/자막/싱크/폴백 튜닝 | 1일 | 실기 리모컨 조작 |
| 4 | 전원/생명주기/기기명/키 안전성 | 0.5~1일 | 앱 전환, 절전, 재부팅 |
| 5 | 자동화/문서/CI | 0.5일 | 원클릭 빌드·설치 |

> 1~3단계는 실기 테스트가 필수이며, TV 모델에 따라 소요가 달라질 수 있다.

---

## 5. 실기 검증 체크리스트

### 재생

- [ ] H.264 1080p MP4 Direct Play
- [ ] HEVC 1080p / 4K HDR10 MKV Direct Play (트랜스코딩 사유 없음)
- [ ] HLG / Dolby Vision(모델 지원 시) 색/밝기 정상
- [ ] TrueHD / DTS-HD / AC3 / EAC3 오디오 (TV 스피커 + eARC)
- [ ] PGS / ASS / SRT 자막 표시·전환·오프셋
- [ ] 탐색(±10초, ±1분), 이어보기, 다음 에피소드
- [ ] 일시정지 후 장시간 대기 → 재생/화면 보호기
- [ ] 트랜스코딩 HLS 재생(서버 부하 낮은 설정)

### UX / 리모컨

- [ ] 재생/일시정지/정지/앞으로/뒤로 키
- [ ] Back: OSD 닫기 → 루트에서 종료 확인
- [ ] 앱 전환(홈) 후 복귀 시 상태
- [ ] TV 절전/화면 보호기 동작
- [ ] 네트워크 끊김/서버 재시작 복구
- [ ] 서버 대시보드에서 기기명 구분

---

## 6. 필요한 정보

실기 반영 전 아래 정보가 필요하다.

1. TV 모델 코드와 연식 (예: `QN65Q80BAFXZA`, 2022)
2. Tizen 버전 (설정 → 지원 → 정보)
3. Jellyfin 서버 버전 (10.10.x / 10.11.x)
4. 서버 주소(IP:포트), TV IP
5. TV 개발자 모드 활성화 여부 (Host PC IP)
6. eARC/AVR/사운드바 연결 여부
7. 리모컨 종류(기본/스마트 리모컨)

---

## 7. 참고 자료

- upstream: <https://github.com/jellyfin/jellyfin-tizen>
- AVPlay 레퍼런스 구현: <https://github.com/dmitrylyzo/jellyfin-tizen> (`avplay` 브랜치, MPL-2.0)
- Samsung AVPlay 가이드: <https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html>
- Samsung TV 비디오 규격(연도별): <https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html>
- 관련 upstream 이슈: #90(TrueHD/DTS), #163(4K HDR MKV), #202(PGS), #286(HEVC)
- Moonfin Tizen(참고): <https://github.com/Moonfin-Client/Smart-TV>
