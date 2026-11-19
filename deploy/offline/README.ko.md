# 로컬 모델과 통제된 웹 접근

이 배포는 macOS 또는 Linux에서 DeepSeek Harness를 Docker 컨테이너로 실행합니다. DSH 프로세스는 선택한 비공개 모델 서버에만 모델 요청을 보내며, 공개 인터넷으로 직접 나가는 경로가 없습니다. 웹 검색과 페이지 가져오기는 별도 수집기가 사용자의 승인을 받은 뒤 처리합니다.

## Pigma 배포

가족 테스트 계정 세 개에는 병합된 플러그인 커밋 `a438454eb800a64ea217238095970b44578d074b`와 Firefox 기반 Camoufox `159.0-beta.42`가 적용되어 있습니다. Chromium 모드용 ARM64 Chrome for Testing `158.0.8127.36`도 같은 이미지에 포함됩니다. Pigma에서는 계정별 자동 승인이 검색과 허용되는 공개 페이지 가져오기에 적용됩니다. 관리형 브라우저의 origin 허용 목록은 별도 설정입니다. 저장소 기본 수집기는 검색만 자동 승인하며 공개 페이지 가져오기는 승인 요청을 표시합니다.

제품 페이지를 읽을 수 없으면 같은 모델의 공식 발표나 문서를 확인합니다. 검증에 사용한 대체 출처는 [Raspberry Pi 5 공식 발표](https://www.raspberrypi.com/news/introducing-raspberry-pi-5/)입니다.


## 빌드와 실행

저장소 루트에서 DSH 이미지를 빌드합니다. 빌드 시 `homelab-dsh-plugins` 저장소의 고정 커밋을 가져와 플러그인 패키지를 준비합니다. 검색 서비스를 처음 자동 실행할 때도 고정한 SearXNG와 RustXNG 소스를 가져와 빌드할 수 있습니다. 실행기는 DSH 이미지나 플러그인을 실행 중에 내려받지 않습니다.

```sh
docker build --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) -f deploy/offline/Dockerfile -t dsh-offline:local .
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1
```

호스트에는 Docker와 Python 3이 필요합니다. root가 아닌 사용자로 실행하세요. 작업공간은 호스트 홈 디렉터리나 컨테이너 시스템 경로와 겹치면 안 됩니다. 상태 디렉터리는 작업공간과 분리하고 다른 사용자가 읽지 못하도록 보관합니다. 작업공간과 상태 디렉터리에 기존 Unix 소켓이 있으면 실행기는 거부합니다. UI와 승인 페이지는 호스트 루프백 주소에만 게시됩니다.

모델 서버는 `/v1` 경로를 제공하는 비공개 IPv4 HTTP 서버여야 합니다. 릴레이는 모델 경로만 전달하고 자격 증명과 쿠키를 제거하며 요청 본문을 로그에 남기지 않고 리다이렉트를 거부합니다. 로컬 프록시가 외부 모델 서비스로 요청을 전달하면 모델 데이터는 해당 서비스로 전송되므로 요청을 로컬에 보관하는 서버를 사용하세요.

UI는 `http://127.0.0.1:3081`에서 열리고 collector 호스트 포트 기본값은 `3083`입니다. 실행기는 제어 터미널에 승인 URL을 표시합니다. 터미널이 없는 작업은 작업공간과 상태 디렉터리 밖에 `--approval-file /absolute/private-file`을 지정할 수 있습니다. 파일은 권한 0600으로 만들고 실행이 끝나면 지웁니다.

`--profile headless`는 UI를 끕니다. `--port`, `--collector-port`, `--context-window`, `--max-tokens`로 로컬 포트와 모델 한도를 설정할 수 있습니다. `--model-patch`는 작업공간 안의 신뢰하는 Cordis 오버레이를 받습니다. 플러그인이나 브라우저 설정을 바꿀 수 있지만 컨테이너 방화벽 정책은 바뀌지 않습니다.

## 플러그인 선택

선택 가능한 플러그인 패키지는 [homelab-dsh-plugins](https://github.com/recrack/homelab-dsh-plugins)의 고정 커밋에서 가져와 Docker 이미지 빌드 시 포함합니다. 이 실행기의 `--plugin <ID>`는 이미지에 포함된 패키지를 지속 Web 프로필에 활성화합니다. DSH Plugin Manager UI와 도구는 꺼져 있으므로 별도 UI 설치는 지원하지 않으며, 실행 중 플러그인 코드를 내려받지도 않습니다. 새 상태 디렉터리에서는 선택 플러그인이 자동 활성화되지 않고, 한 번 선택한 플러그인은 이후 실행에도 유지됩니다. 저장소 간 흐름은 [homelab-dsh-plugins 설명](https://github.com/recrack/homelab-dsh-plugins#how-the-secure-deployment-uses-these-packages)과 아래 Archify 그림을 참고하세요.

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --plugin dsh-context --plugin dsh-claude-artifacts --plugin dsh-claude-design --plugin dsh-crew
```

사용 가능한 ID는 `dsh-browser`, `dsh-context`, `dsh-claude-artifacts`, `dsh-claude-design`, `dsh-crew`입니다. `dsh-context`의 고정본은 자동 카탈로그, 잔액, 추천 요청을 차단합니다. Baoyu 플러그인은 로컬 Artifacts 페이지와 디자인 캔버스를 제공합니다. DSH Crew는 실행 중인 DSH 허브를 사용하고 두 작업자 계층에 선택한 로컬 모델을 적용합니다. 비전과 이미지 생성 제공자는 꺼져 있습니다.

`dsh-browser`는 기본적으로 탐색 대상이 없습니다. 로컬 페이지를 허용하려면 매 실행마다 `dsh-browser`를 고르고 정확한 루프백 또는 사설 IPv4 origin을 지정합니다. origin을 여러 개 허용할 때는 옵션을 반복합니다. 선택형 이미지에서 `--browser-engine camoufox`를 추가하면 Camoufox를 사용하며, 기본 엔진은 Chromium입니다.

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --plugin dsh-browser --browser-origin http://127.0.0.1:4173
```

루프백 주소는 DSH 컨테이너를 가리킵니다. 브라우저 페이지가 하위 리소스를 요청할 수 있지만 방화벽은 지정한 주소와 포트만 허용합니다. 공개 웹사이트는 승인된 Web 수집기를 사용하세요.

`dsh-browser`는 기본으로 Chromium을 사용합니다. Camoufox는 같은 플러그인에서 선택하는 Firefox 기반 엔진입니다. 로컬 기본 이미지에서 선택형 이미지를 빌드하면 고정한 Camoufox 패키지와 짝을 이루는 브라우저 빌드 및 검증된 지문 모델을 이미지 빌드 때 설치합니다.

```sh
docker build --build-arg DSH_BASE_IMAGE=dsh-offline:local -f deploy/offline/Dockerfile.camoufox -t dsh-offline:camoufox .
python3 deploy/offline/run.py --image dsh-offline:camoufox --browser-engine camoufox --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --plugin dsh-browser --browser-origin http://127.0.0.1:4173
```

기본 이미지에는 Camoufox 브라우저와 지문 모델이 들어가지 않습니다. 선택형 이미지의 세션은 이미지에 설치된 읽기 전용 파일만 사용하며, 파일이 없으면 런타임 다운로드 없이 시작에 실패합니다. 기존 컨테이너 방화벽은 모델 릴레이, collector, 지정한 사설 origin으로만 브라우저 연결을 허용합니다. origin 허용 목록을 켠 Camoufox는 최상위 HTTP redirect를 거부하므로 최종 URL을 직접 지정합니다. Camoufox는 Chromium DevTools Protocol을 제공하지 않아 닫힌 Shadow DOM 검사는 `cdp-unavailable`로 보고하며, 시각 캡처 배율은 `1`만 지원합니다.

### 이미지 빌드와 프로필 활성화

플러그인 저장소는 검토한 소스 스냅샷과 로컬 보완을 관리하고, secure 저장소는 이미지를 만들고 허용된 ID를 지속 프로필에 활성화합니다. 실행 시 플러그인 저장소를 clone하거나 패키지를 빌드하지 않습니다.

호스트 실행기는 현재 `cordis.patch.yml`과 `prepare-presets.mjs`를 읽기 전용으로 컨테이너에 연결합니다. 모델 provider 설정과 preset 안전 수정은 다음 런타임 재시작부터 적용되며 이미지를 다시 빌드할 필요가 없습니다. 플러그인 패키지나 컴파일된 DSH 코드를 바꾸면 이미지를 다시 빌드해야 합니다.

플러그인 저장소의 고정 스냅샷부터 이미지 빌드, 명시적 선택, 프로필 연결, 제한된 런타임까지는 [Archify 플러그인 빌드·활성화 그림](../../.archify/architecture-dsh-plugin-activation-20261115-010540/architecture.html)에 정리했습니다. 로컬 checkout에서는 standalone HTML을 브라우저로 여세요.

`run.py --plugin <ID>`는 이미지에 이미 들어 있는 패키지만 선택합니다. 시작할 때 [profile_plugins.py](profile_plugins.py)가 선택된 패키지를 로컬 의존성으로 기록하고 패키지 경로를 지속 Web 프로필에 연결하며 기존 선택을 보존합니다. bundle 플러그인은 `dsh.profile.bundles`에 추가되고, `dsh-browser`는 생성된 오버레이를 통해 기본 Web preset에 추가됩니다. 일반 Cordis 로더가 프로필을 실행하며 플러그인 코드는 DSH 컨테이너 안에서 동작하고 같은 방화벽 정책을 따릅니다.

플러그인을 새로 추가할 때는 두 저장소를 모두 수정해야 합니다. 플러그인 저장소에 검토한 스냅샷과 빌드 요건을 추가하고, secure 저장소에서 [이미지 패키지 링크](Dockerfile), [허용 ID 목록](run.py), [프로필 패키지와 bundle 매핑](profile_plugins.py)을 추가합니다. 모든 새 ID를 [prepare-presets.mjs](prepare-presets.mjs)의 ID 목록에도 등록하고, preset 방식이면 해당 preset 행을 추가합니다. 플러그인 저장소의 `plugins.json`만 수정해도 실행기가 해당 플러그인을 자동으로 찾지는 않습니다. 이미지에 포함되도록 다시 빌드한 뒤 `--plugin <ID>`로 선택합니다.

일반 DSH 플러그인 개발은 [첫 플러그인 만들기](../../docs/user/develop/basic/index.md)와 [플러그인 패키징 및 설치](../../docs/user/develop/basic/publish.md)를 참고하세요. 검색 또는 가져오기 백엔드는 [dsh-web provider 추가](../../packages/web/web/README.md#adding-a-provider) 방식으로 확장할 수 있습니다. 이 배포는 Host의 Plugin Manager 제공자와 각 agent preset의 `tool-plugin-manager` 도구를 모두 끕니다. 표준 preset이 프로필 컨텍스트에서 도구를 다시 켜 새 세션이 제공자 대기 상태로 실패하지 않게 합니다. `deploy/offline/profile_plugins.py`는 사용자가 고른 카탈로그 항목만 프로필에 설치합니다.

## 데이터 흐름과 네트워크

```mermaid
flowchart LR
    User[사용자] --> DSH[DSH 에이전트]
    DSH -->|모델 경로만| Relay[로컬 모델 릴레이]
    Relay -->|비공개 IP| Model[선택한 모델 서버]
    DSH -->|검색어 또는 URL 제출| Collector[승인 수집기]
    User -->|정확한 요청 승인| Collector
    Collector -->|승인된 검색어| Search[로컬 SearXNG / RustXNG]
    Search -->|검색어만| PublicSearch[공개 검색 제공자]
    Collector -->|승인된 URL만| PublicSite[공개 웹사이트]
    DSH -. 직접 공개 인터넷 송신 차단 .-> PublicSearch
```

DSH 컨테이너의 IPv4와 IPv6 입력·출력 기본 정책은 DROP입니다. 허용되는 연결은 루프백, 선택한 모델 릴레이, 수집기 API, Web UI 게시 포트, 그리고 `--browser-origin`으로 지정한 사설 주소뿐입니다. Docker DNS도 차단합니다. 프로세스는 모든 capability를 버리고 `no-new-privileges`를 켠 뒤 시작합니다.

기본 Cordis 오버레이는 DeepSeek 모델 및 계정 provider, DeepSeek 검색 provider, 원격 세션 로그, OpenTelemetry 세션 텔레메트리, Plugin Manager, 제품 분석, 계정 UI를 끕니다. `api.deepseek.com`을 포함한 DeepSeek 도메인으로 직접 연결할 수 없습니다. 모델 릴레이는 요청 로그를 만들지 않습니다. 이 설정은 이 Docker 배포에 적용됩니다. 직접 지정한 모델 서버, 수동 검색 서비스, Hermes sidecar, 신뢰하는 `--model-patch`의 정책은 별도로 확인해야 합니다.

수집기는 검색에 `{query,maxResults}`, 가져오기에 `{url}`만 받습니다. 기본 설정에서는 요청을 호스트 전용 승인 페이지에 표시하고 사용자가 승인할 때까지 보류합니다. `--auto-approve-search`를 지정하면 검색 요청만 자동 승인하며 공개 URL 가져오기는 계속 매번 승인받습니다. 검색 제공자는 검색어와 검색 서비스의 공개 IP를 볼 수 있습니다. 공개 페이지에는 승인한 URL을 수집기가 요청하므로 사이트는 수집기의 공개 IP를 봅니다. 대화 기록, 파일, 자격 증명, 세션 로그는 검색어나 페이지 요청에 포함되지 않습니다.

검색은 기본적으로 자동 시작됩니다. 실행기는 검토한 이미지 digest와 DSH 오프라인 설정 라벨을 모두 가진 컨테이너만 재사용하며, 다른 기존 컨테이너는 연결하지 않습니다. 적합한 컨테이너가 없으면 고정 이미지를 사용하고, 이미지가 없을 때는 고정 upstream digest를 먼저 확인한 뒤 고정 커밋을 `~/.cache/dsh-offline/search-services`에 clone해 빌드합니다. 기존 서비스를 직접 관리한다면 두 엔진 URL과 네트워크 이름을 지정할 수 있습니다. `--search off`는 자동 실행을 끄며, 이 옵션과 `--auto-approve-search`는 함께 사용할 수 없습니다.

관리형 SearXNG는 Google, Bing, DuckDuckGo, Brave만 사용합니다. 관리형 RustXNG는 DeepSeek 검색 엔진과 리서치 API를 끄고 직접 가져오기 방식을 사용합니다. 로컬 엔진은 승인된 검색어만 받고 DeepSeek API로 대체 전송하지 않습니다. `searxng:` 또는 `rustxng:` 접두어는 엔진 하나를 고르며, 다른 검색은 두 엔진 결과를 합칩니다. 검색 실패나 가져오기 실패 시 다른 provider로 자동 전환하지 않습니다.

수집기는 사용자 승인 후 공개 HTTP(S) URL을 가져올 수 있습니다. `deepseek.com`과 하위 도메인은 승인 또는 DNS 조회 전에 거부합니다. 검색 수집기는 대화 기록, 파일, 쿠키, 자격 증명을 로컬 검색 엔진에 전달하지 않습니다. 공개 검색어에는 비밀이나 사설 프로젝트 정보를 넣지 마세요.

## 로컬 검색 서비스

이미 검색 서비스를 관리한다면 두 endpoint URL과 네트워크 이름을 설정해 자동 검색 서비스 탐색 대신 사용합니다.

```sh
export DSH_SEARXNG_URL=http://172.30.0.3:8080
export DSH_RUSTXNG_URL=http://172.30.0.4:8080
export DSH_SEARCH_NETWORK=search-local-only
```

수동 엔진은 사설 IPv4 주소에서 동작하고 SearXNG 호환 `/search` JSON endpoint를 제공해야 합니다. `searxng:` 또는 `rustxng:`로 시작하는 요청은 해당 엔진만 사용하며, 나머지는 양쪽 결과를 합칩니다. 승인된 검색 요청은 정확한 검색어와 결과 수만 로컬 엔진으로 보냅니다. 자동 승인 모드에서는 검색어가 승인 화면을 거치지 않고 전달됩니다.

## Hermes ACP

Hermes는 선택 가능한 ACP 하위 에이전트 backend이며 DSH 모델 provider가 아닙니다. DSH 조정자는 선택한 로컬 모델을 계속 사용하고, `Hermes + Qwen` preset은 Hermes sidecar에 코딩 작업을 위임합니다. 먼저 검증된 Hermes sidecar를 실행한 뒤 기존 Docker volume을 전달합니다.

```sh
python3 deploy/offline/run.py --workspace /absolute/project --state /absolute/private-dsh-state --model MODEL_ID --base-url http://127.0.0.1:18080/v1 --plugin dsh-crew --hermes-acp-volume dsh-hermes-acp-socket
```

볼륨은 `/run/hermes-acp`에 읽기 전용으로 마운트합니다. 소켓은 미리 만들어져 있어야 하며 호스트 사용자의 숫자 UID로 연결 가능해야 합니다. DSH Crew 조정자는 프로젝트 파일을 읽고 작업을 위임할 수 있지만 직접 파일을 쓰거나 명령을 실행하거나 도구를 설치할 수 없습니다. 별도 관리하는 sidecar 안의 네트워크 정책은 이 실행기가 강제할 수 없으므로 로컬 모델 endpoint를 사용하고 자체 텔레메트리와 공개 egress를 꺼야 합니다.

## 세션 데이터와 검사

실행기는 세션 호환성을 위해 작업공간을 호스트의 절대 경로로 컨테이너에 마운트합니다. 기존 Session과 첨부 파일은 상대 경로와 generation을 보존해 `STATE/home/.dsh`로 복사할 수 있습니다. 호스트 자격 증명이나 호스트 플러그인 설정은 복사하지 마세요.

```sh
python3 -m unittest discover -s deploy/offline -p 'test_*.py'
node --import tsx/esm --test deploy/offline/collector.test.mjs deploy/offline/local-search.test.mjs deploy/offline/web-provider.test.mjs deploy/offline/browser-policy.test.mjs deploy/offline/prepare-presets.test.mjs deploy/offline/preset-guard.test.mjs
```
