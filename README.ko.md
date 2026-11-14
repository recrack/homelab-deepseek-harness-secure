# Homelab DeepSeek Harness Secure

[English](README.md) | 한국어

이 저장소는 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)를 로컬 모델과 통제된 웹 접근을 제공하는 배포 형태로 구성합니다. 빌드와 실행 방법은 [배포 안내](deploy/offline/README.ko.md)를 참고하세요.

## 아키텍처와 기술 스택

DSH 에이전트, 모델 릴레이, 승인 수집기, 검색 서비스를 분리합니다. DSH 에이전트에는 공개 인터넷으로 직접 나가는 경로가 없습니다. 검색어나 페이지 주소를 공개 서비스로 보내려면 별도 구성 요소에서 요청 내용을 확인하고 승인해야 합니다.

| 구성 요소 | 스택 | 역할 |
| --- | --- | --- |
| 호스트 실행기와 모델 릴레이 | Python 3 표준 라이브러리, Docker CLI | 선택한 사설 IPv4 모델 endpoint를 확인하고 제한된 모델 릴레이를 실행하며, 실행별 컨테이너와 네트워크를 관리합니다. |
| DSH 에이전트 | Debian Bookworm 기반 Node.js 24, pnpm 11.28.5, TypeScript/ESM, Cordis | 배포 오버레이에서 텔레메트리, 계정 provider, 원격 세션 로그를 끈 Web 또는 headless 프로필을 실행합니다. |
| 네트워크 제한 | Linux `iptables`, `ip6tables`, `setpriv` | DSH 로딩 전에 기본 거부 규칙을 적용하고 Docker DNS를 차단한 뒤 에이전트 프로세스의 Linux capability를 제거합니다. |
| 승인 웹 수집기 | 별도 Node.js ESM 컨테이너와 DSH `public-web` 프로필 | 검색어나 가져올 URL을 사용자 승인 화면에 표시한 뒤 승인된 요청만 전달합니다. 작업공간과 Session 디렉터리는 마운트하지 않습니다. |
| 검색 엔진 | Python 기반 [SearXNG](https://github.com/searxng/searxng), Rust 기반 [RustXNG](https://github.com/sahenjp/RustXNG) | 사설 Docker 네트워크에서 실행합니다. 승인된 검색어는 설정된 공개 검색 provider에 전달될 수 있습니다. |

이 구성은 DSH 에이전트의 직접 공개 송신을 차단하고 DSH 프로필의 DeepSeek 모델, 검색, 계정, 텔레메트리, 세션 로그 provider를 끕니다. 승인된 검색어와 페이지 요청은 수집기 및 검색 서비스에서 외부로 나갈 수 있습니다. 지정한 모델 서버나 프록시가 요청을 다시 upstream으로 전달할 수도 있습니다.

## 플러그인 아키텍처

이미지 빌드 시 [homelab-dsh-plugins](https://github.com/recrack/homelab-dsh-plugins)의 고정 revision을 가져와 Node.js 패키지를 빌드합니다. DSH 시작 시 플러그인 저장소를 clone하거나 패키지를 내려받지 않습니다. 실행기는 `--plugin`으로 선택한 ID만 로컬 패키지 링크를 사용해 영속 Web 프로필에 설치합니다.

`dsh-context`, `dsh-claude-artifacts`, `dsh-claude-design`, `dsh-crew`는 Cordis patch를 프로필에 추가하는 bundle입니다. `dsh-browser`는 선택했을 때 제공된 preset에 Cordis 플러그인 항목으로 삽입합니다. 플러그인을 선택해도 컨테이너 방화벽은 바뀌지 않습니다. 브라우저 탐색에는 정확한 로컬 origin 허용 목록이 필요합니다.

디자인 플러그인은 `dsh-claude-artifacts`에 의존하며 이 패키지는 로컬 Artifacts 페이지를 제공합니다. 디자인 플러그인의 upstream은 이전 Baoyu Design에서 이름이 바뀐 [Open Artifacts](https://github.com/JimLiu/open-artifacts)입니다. `homelab-dsh-plugins`의 고정 revision을 갱신하고 이미지를 다시 빌드하기 전까지는 이 이미지에 반영되지 않습니다.

## 보안 배포 실행

Docker 배포를 빌드하고 실행하려면 [한국어 배포 안내](deploy/offline/README.ko.md) 또는 [English deployment guide](deploy/offline/README.md)를 따르세요. 네트워크와 텔레메트리 제한이 필요한 경우 upstream의 `npx @deepseek-ai/dsh web` 명령을 실행하지 마세요. 이 명령은 이 저장소의 Docker 정책을 적용하지 않습니다.

upstream DSH 아키텍처 및 플러그인 개발은 [아키텍처](docs/architecture.md), [첫 플러그인 만들기](docs/user/develop/basic/index.md), [플러그인 패키징 및 설치](docs/user/develop/basic/publish.md)를 참고하세요.

## 라이선스

이 저장소는 [MIT](LICENSE) 라이선스를 따릅니다. 제3자 의존성과 각 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
