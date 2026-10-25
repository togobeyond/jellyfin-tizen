# 빌드 & 배포 가이드 (macOS)

이 문서는 이 저장소를 실제 Samsung TV에 올리는 절차를 정리한 것이다.
기본적인 upstream 절차는 [README](../README.md)를 따르고, 여기서는 macOS/Apple Silicon에서
실제로 막히는 부분과 이 프로젝트에서 사용하는 명령을 기록한다.

## 1. 준비물

- Node.js: jellyfin-web `release-12.z`는 Node 24+, `release-10.10.z`는 Node 20+ (검증: 12.3은 Node 24.22.0)
- JDK 17 (`/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk`)
- Tizen CLI (`~/tizen-studio/tools/ide/bin/tizen`)
- jellyfin-web 소스 (서버와 같은 버전 권장: 서버 12.3 → `release-12.z`)
- 서명 인증서 프로필 (TV 설치 시 필요)

## 2. jellyfin-web 빌드

```sh
cd ../jellyfin-web-12.3   # 서버 12.3 기준
npm ci --no-audit
USE_SYSTEM_FONTS=1 npm run build:production
```

> `USE_SYSTEM_FONTS=1`은 폰트를 줄여 앱 용량과 메모리를 줄인다.

## 3. Tizen 앱 준비

```sh
cd ../jellyfin-tizen
JELLYFIN_WEB_DIR=../jellyfin-web-12.3/dist npm ci --no-audit
JELLYFIN_WEB_DIR=../jellyfin-web-12.3/dist npm run build
```

`www/`에 jellyfin-web + `tizen.js` + `avplayVideoPlayer.js` + `tizen.css`가 포함된다.
`www/index.html`에 아래 스크립트가 순서대로 들어갔는지 확인한다.

```html
<script src="$WEBAPIS/webapis/webapis.js"></script>
<script src="../tizen.js" defer></script>
<script src="../avplayVideoPlayer.js" defer></script>
<script src="main.jellyfin.bundle.js" defer></script>
```

## 4. WGT 패키징

```sh
export PATH="$HOME/tizen-studio/tools/ide/bin:$PATH"
export JAVA_TOOL_OPTIONS="--add-opens=java.base/java.lang=ALL-UNNAMED"

tizen build-web -e ".*" -e gulpfile.babel.js -e README.md \
  -e "node_modules/*" -e "package*.json" -e "yarn.lock" \
  -e "docs/*" -e "tools/*"
tizen package -t wgt -o . -- .buildResult
```

결과: `Jellyfin.wgt`

> `tizen package`가 "Default profile is used for sign"이라고 경고하면 **에뮬레이터용** 서명이다.
> 실제 TV 설치 전에는 아래 서명 프로필을 사용해야 한다.

## 5. 서명 프로필

```sh
tizen security-profiles list
tizen security-profiles add -n <profile> -A \
  -a <author.p12> -p <author-password> \
  -d <distributor.p12> -dp <distributor-password>

tizen package -t wgt -s <profile> -o . -- .buildResult
```

- 2017~2022 TV: Tizen(public) 인증서로 설치 가능
- 2023+ (Tizen 7+): Samsung 계정으로 만든 Samsung 인증서가 필요할 수 있다.
- 업데이트는 **같은 author 인증서**로 서명해야 한다.

이 컴퓨터에는 `jellyfin-tv` 프로필이 등록되어 있다.

- author 인증서: `~/.jellyfin-tizen/certs/jellyfin-author.p12`
- author 비밀번호: macOS Keychain `jellyfin-tizen-author`
- distributor: `~/share/.tizen-cert/distributor/tizen-distributor-signer.p12`

```sh
tizen package -t wgt -s jellyfin-tv -o . -- .buildResult
```

## 6. TV 설치

가장 간단한 방법은 커뮤니티 도구를 쓰는 것이다.

1. TV에서 개발자 모드 활성화: `Apps` → 리모컨 `1 2 3 4 5` → Developer mode ON,
   Host PC IP에 이 컴퓨터 IP 입력 → TV 재부팅
2. TizenBrew Installer 또는 `sdb`/`tizen install`로 `Jellyfin.wgt` 설치

이 저장소에는 SDB 프로토콜(26101)을 직접 구현한 설치 스크립트가 포함되어 있다.
Tizen Studio나 `sdb` 없이 Python 3만으로 설치/업데이트/삭제할 수 있다.

```sh
python3 tools/install.py <TV_IP>              # 설치 또는 업데이트 후 실행
python3 tools/install.py <TV_IP> --uninstall  # 삭제
```

설치 후 앱이 바로 뜨지 않으면 TV의 Apps에서 `Jellyfin`을 실행한다.

## 7. 이 환경에서 발생했던 문제

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| `NoClassDefFoundError: org/tizen/web/common/WebConstant` | Tizen Studio에 Web CLI 컴포넌트 누락 | `new-web-cli` 패키지 병합 |
| `NoClassDefFoundError: org/tizen/core/gputil/XMLUtil` | `new-web-cli`의 `gputil.jar` 누락 | 위와 동일 |
| `ClassNotFoundException: javax.xml.bind.JAXBException` | JDK 17에서 JAXB 제거 | `jaxb-api-2.3.1.jar` 추가 |
| `JAXBException` / `InaccessibleObjectException` | 구 JAXB + JDK 17 모듈 제한 | `JAVA_TOOL_OPTIONS=--add-opens=java.base/java.lang=ALL-UNNAMED` |
| `sdb` 없음 / Rosetta 이슈 | Tizen Studio sdb가 Intel 바이너리 | Python SDB 설치 스크립트 사용 |

## 8. 자막 폰트

자막은 `tizen.css`의 `.avplaySubtitle`에 지정된 폰트로 DOM 렌더링된다.
기본 폰트는 `a시네마M`이며, 아래 위치에 두면 WGT에 포함된다.

```sh
cp "/path/to/a시네마M.ttf" fonts/ACinemaM.ttf
```

> 폰트 파일은 저작권 문제로 Git에 커밋하지 않는다(`.gitignore`).
> 파일이 없으면 `sans-serif`로 대체된다.

## 9. 릴리스 체크리스트

- [ ] `config.xml` / `package.json` 버전 증가 (TV 업데이트 인식)
- [ ] `USE_SYSTEM_FONTS=1`로 웹 빌드
- [ ] `Jellyfin.wgt` 서명 프로필 확인
- [ ] 실제 TV에서 재생/자막/오디오/리모컨 확인
- [ ] 서버 대시보드에서 기기명/재생 방식(Direct Play) 확인
