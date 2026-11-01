# TVHeadend 녹화 프록시

TVHeadend가 녹화 중인 `.ts` 파일을 Jellyfin 라이브 채널처럼 재생한다.
파일이 커지는 만큼 계속 읽어서, 녹화가 끝나기 전에도 처음부터 끝까지 볼 수 있다.

```text
TVHeadend 녹화 (.ts, 계속 커짐)
        │
        ▼
  tvh-proxy (이 디렉터리)
  /live/slot/N → 파일을 chunked TS로 계속 전송
        │
        ▼
Jellyfin M3U 튜너
  http://<서버>:8099/playlist.m3u
        │
        ▼
TV 앱 (0.3.16+)이 프록시 TS를 직접 재생하고,
탐색 시 해당 위치로 재접속
```

## 구성

`node:22-alpine` 컨테이너 하나만 추가한다. Jellyfin 컨테이너는 그대로 둔다.

```yaml
  tvh-proxy:
    image: node:22-alpine
    container_name: tvh-proxy
    restart: unless-stopped
    command: node /app/server.js
    network_mode: "host"
    volumes:
      - /home/carrot/jellyfin/tvh-proxy:/app:ro
      - /media/Win/recordings:/recordings:ro
    environment:
      TZ: Asia/Seoul
      PORT: "8099"
      RECORDINGS_DIR: /recordings
      PUBLIC_URL: "http://192.168.1.4:8099"
      JELLYFIN_URL: "http://127.0.0.1:8096"
      JELLYFIN_TOKEN: "<Jellyfin API 키>"
```

```sh
docker compose up -d tvh-proxy
curl http://192.168.1.4:8099/health
```

## Jellyfin 설정

1. **Live TV → Tuner Devices → Add Tuner → M3U**
2. URL: `http://192.168.1.4:8099/playlist.m3u`
3. **Refresh Guide** 한 번 실행
4. 채널 `1.1 TVH 녹화 1` ~ `1.4 TVH 녹화 4` 생성 (기존 `2.1` 채널보다 앞)

슬롯이 고정되어 있어서, 새 녹화가 시작되어도 가이드 새로고침이 필요 없다.
녹화가 하나면 `TVH 녹화 1`, 두 개면 1·2 순서로 매핑된다.
현재 매핑은 `/health`에서 확인할 수 있다.

`JELLYFIN_URL`과 `JELLYFIN_TOKEN`을 설정하면, 녹화가 시작·종료될 때
프록시가 Jellyfin 가이드 갱신을 자동으로 요청한다. 그래서 채널 이름이
`TVH 녹화 1 · <녹화 중인 프로그램>`으로 자동 변경된다. 토큰은
Jellyfin **대시보드 → API 키**에서 새로 만든다.

> 채널 이름은 Jellyfin이 캐시하므로, 자동 갱신을 쓰지 않으면
> 녹화가 바뀌어도 이름이 그대로일 수 있다.

앱 **0.3.16+**는 프록시 채널(`TVH 녹화 …`)을 Jellyfin 변환 없이 **프록시 TS로
직접 재생**한다. 프록시가 TS의 PCR을 샘플링해 `시간 ↔ 파일 위치` 인덱스를 만들고,
앱은 탐색할 때 해당 위치로 **재접속**한다. 그래서 녹화 시작·중간·라이브 엣지로
자유롭게 이동할 수 있고, 재생시간은 녹화가 진행되며 늘어난다.
일반 라이브 채널은 기존처럼 DirectPlay를 유지한다.

- 첫 탐색은 인덱스 생성 때문에 몇 초 걸릴 수 있다.
- 이동 시 1~3초 재버퍼링이 있다.
- 라이브 엣지는 키프레임 확보를 위해 약 5초 앞에서 시작한다.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8099` | HTTP 포트 |
| `RECORDINGS_DIR` | `/recordings` | 녹화 디렉터리 (읽기 전용) |
| `PUBLIC_URL` | 요청 Host | M3U에 쓸 외부 주소 |
| `SLOT_COUNT` | `4` | 고정 채널 개수 |
| `SLOT_CHANNEL_BASE` | `1` | 채널 번호 앞자리 (`1` → `1.1`~`1.4`) |
| `JELLYFIN_URL` | 없음 | 가이드 자동 갱신용 Jellyfin 주소 |
| `JELLYFIN_TOKEN` | 없음 | 가이드 자동 갱신용 API 키 |
| `ACTIVE_WINDOW_MS` | `120000` | 최근 수정된 파일을 녹화 중으로 볼 시간 |
| `IDLE_GRACE_MS` | `30000` | 파일이 자라지 않을 때 스트림을 닫는 시간 |
| `THROTTLE_ADDRESSES` | `192.168.1.4` | 이 주소에서 오는 스트림은 속도 제한 (Jellyfin) |
| `THROTTLE_BYTES_PER_SEC` | `4000000` | 제한 속도 (약 4MB/s, 실시간의 1.7배) |

> Jellyfin M3U 튜너는 프록시 스트림을 디스크 속도로 복사합니다(30~40MB/s).
> TV가 프록시를 직접 재생할 때 같은 디스크를 두 번 읽어 로딩이 느려지므로,
> Jellyfin 쪽 스트림만 실시간보다 조금 빠르게 제한합니다.

## 엔드포인트

| 경로 | 설명 |
| --- | --- |
| `/playlist.m3u` | 고정 슬롯 채널 (Jellyfin 튜너용) |
| `/playlist.m3u?dynamic=1` | 녹화별 채널 (디버그용, 새로고침 필요) |
| `/playlist.m3u?all=1` | 완료된 녹화까지 모두 표시 |
| `/info/slot/1` | 슬롯 1의 재생시간/상태 |
| `/info/slot/1?t=<ms>` | 해당 시각의 실제 시작 위치 (`startMs`, `offset`) |
| `/info/slot/1?t=live` | 라이브 엣지(-5초) 시작 위치 |
| `/live/slot/1` | 슬롯 1의 녹화를 계속 스트리밍 (없으면 404) |
| `/live/slot/1?from=<초>` | 지정한 시각부터 스트리밍 (앱이 사용) |
| `/live/slot/1?start=<초 또는 live>` | 시작 위치 지정 (수동 테스트용) |
| `/live/<파일명>` | 특정 녹화를 직접 스트리밍 |
| `/health` | 상태와 슬롯 매핑 |

### 시간 인덱스

- 파일을 4MB 간격으로 샘플링해 PCR(90kHz)을 읽고 `시간 ↔ 바이트 위치`를 저장한다.
- 녹화가 자라면 새 구간만 이어서 스캔한다.
- `/info?t=`는 필요한 인덱스가 준비될 때까지 최대 10초 기다린 뒤 정확한 위치를 준다.
- 인덱스는 프록시 메모리에만 있고 재시작하면 다시 만든다.

## 전제

- TVHeadend DVR 프로필이 **MPEG-TS (pass)** 여야 한다. MKV 녹화는 지원하지 않는다.
- 녹화 파일이 `RECORDINGS_DIR` 바로 아래에 있어야 한다. (하위 폴더는 스캔하지 않음)
- 프록시 컨테이너가 녹화 디렉터리를 읽을 수 있어야 한다.
- 녹화가 끝나면 슬롯이 비고, 채널은 404가 된다. 채널 자체는 목록에 남는다.
