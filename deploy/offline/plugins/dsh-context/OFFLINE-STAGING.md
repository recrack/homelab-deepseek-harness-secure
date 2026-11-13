# dsh-context — 오프라인 스테이징 (offline staged build)

> **운영 참고 / operator note.** 이 패키지는 오프라인 Web 이미지에 포함됩니다.
> `upstream/`는 수정 금지(원본 보존). `package.json`의 zod 버전은 이미지의 안전한
> `4.6.6`으로 갱신했습니다.

## 1. 신원 / Identity

| 항목 | 값 |
|---|---|
| package name | `dsh-context` |
| version | **0.83.0** |
| license | **Apache-2.0** |
| author | bowenliang123 |
| homepage | https://github.com/bowenliang123/dsh-context |
| main / client | `lib/index.js` / `lib/client.js` (`type: module`) |
| official tarball | `upstream/dsh-context-0.83.0.tgz` |
| engines | node `^22.19.0 \|\| >=24.0.0`, dsh `>=0.2.2-rc.1` |
| runtime zod | upstream `4.4.3`; deployed `4.6.6` |

`upstream/package`는 tarball을 그대로 추출한 **수정 금지 원본**입니다(tarball 대비
sha256 전체 일치 검증 완료). 아래 해시는 **원본 기준**입니다.

### 원본 파일 sha256 (upstream/package)
```
c2dbbcf4c28d85d2ba36952448c86ba41b25d300fa5440ace0ff20c97015d9c3  lib/index.js
5aece21253856759cf8f4d8609c498ba9010bee46fe9dc6751a770a046540989  lib/client.js
72d98abeb13e8ab75d27d29ea6a77179e7234a2f1467a471e53f7495fc0f71ed  lib/index.d.ts
3235aa9335209afad4e4830ce46106728f457b342b3034f8bd55d8c8b843dc58  package.json
15c1a94ab7c53d70704c50effa759d76ec6abf02d07b924308deb45cb9193041  README.md
919857728c4e1d0f76be03af00437d9910c943f883d04c8c58a6a0cb1c3225b0  LICENSE
480715a9626fbb6667ae8b39bfaddf6c96600b624704e1b84109c67e37a9d4dc  icon.svg
f0861d79b2b1e5d3189be811f4d530d17fb3012883cf6791fb7713dbda664c29  cordis.patch.yml
fc9203b1a85081cf73808ca87e226219d111aebef7e2ce3dfc6a090649b421cc  ../dsh-context-0.83.0.tgz
```

## 2. 왜 오프라인 패치가 필요한가

원본 0.83.0은 설치 후 자동적으로 아래 **외부 네트워크**를 조회합니다. 오프라인/폐쇄
망 설치에서는 이 호출이 실패·지연·정보유출 우려를 만들므로, 실제 네트워크를 **치기
직전**에서 로컬 reject로 대체합니다(전역 `fetch`/DSH 도구/타 플러그인은 건드리지 않음).

원본 `lib/index.js`에는 정확히 **3곳**의 네트워크 `fetch` 클로저가 있습니다(그 외 `fetch(` 없음):

| 식별자 | 위치 의미 | 호출 대상 |
|---|---|---|
| `Qi` 기본값 `e.fetch??((e,t)=>fetch(e,t))` | 버전 카탈로그 + 가격표 | `registry.npmjs.org`, `registry.npmmirror.com` (버전), `models.dev/api.json` (가격표) |
| `let Xa=(e,t)=>fetch(e,t)` | 사용자 잔액 | `{baseUrl}/user/balance` (DeepSeek API) |
| `let Gl=(e,t)=>fetch(e,t)` | 추천 배너 | `raw.githubusercontent.com/.../data/recoms.json` + `gh-proxy.org` 미러 |

클라이언트 자동 아이콘: 폴백 추천 아이콘 `https://cdn.simpleicons.org/deepseek`가
`lib/client.js` `<img src=c.icon>`에서 자동 로드됩니다. `lib/index.js`·`lib/client.js`
에 각 1회(총 **2회**) 등장합니다.

## 3. 정확한 패치 내용 (what changed, nothing more)

패치 대상 파일은 **`lib/index.js`, `lib/client.js` 두 개뿐**입니다. 스크립트가
정확히 1회 등장하는 문자열만 치환하며, 개수가 다르면 실패(exit 1)합니다.

**lib/index.js — fetch → 로컬 reject (3곳)**
- `e.fetch??((e,t)=>fetch(e,t))`
  → `e.fetch??(async()=>{throw Error("dsh-context offline: version/price catalog fetch blocked (no network)")})/*dsh-context:offline-blocked*/`
- `let Xa=(e,t)=>fetch(e,t)`
  → `let Xa=(async()=>{throw Error("dsh-context offline: balance fetch blocked (no network)")})/*…*/`
- `let Gl=(e,t)=>fetch(e,t)`
  → `let Gl=(async()=>{throw Error("dsh-context offline: recommendation fetch blocked (no network)")})/*…*/`

`async()=>{throw …}`는 호출 즉시 **Promise.reject** — 소켓 열기 전에 실패하므로
전송 0바이트. 각 함수를 `node:vm`으로 추출·실행하고 **전역 fetch 스파이 호출 0회**를
assert로 검증했습니다(§5).

> **구현 주의(async 함정):** 생성문은 반드시 `(async()=>{…})` 형태로, `async` 토큰이
> `()=>` 바로 앞에 붙어야 합니다. `async(/*주석*/()=>…)`는 non-async로 파싱되어
> `ReferenceError: async is not defined`를 냅니다(`node --check`는 **탐지 못함**).
> 그래서 sentinel 주석은 닫는 괄호 **뒤**에 배치했습니다. vm 런타임 테스트로 실증.

**lib/index.js + lib/client.js — 아이콘 2곳 (치환)**
- `` `https://cdn.simpleicons.org/deepseek` ``
  → 로컬 `` `data:image/svg+xml,...` `` (16×16 남색(#5786FE) 각진 정사각형 + 흰 'C' 글자, 인라인 SVG, CDN 요구 없음)

**유지(변경 없음):** import 목록, 부가기능, Fleet/Context 기본 UI, 프롬프트, locale,
`index.d.ts`, `icon.svg`, `cordis.patch.yml`, 전역 `fetch`, DSH 도구. The deployed
manifest changes only the zod dependency from `4.4.3` to `4.6.6`.
**远程推荐 icon 경로**는 그대로이며 `Gl`이 reject된 뒤 **fallback 경로에서만** 도달합니다
(자동 요청 아님). 로컬 폴백 추천(`{recoms:[zl]}`/`dm`)은 위 data-URI 아이콘을 씁니다.

### 분화한 원격 URL 구분 (자동 요청 vs 사용자 클릭)
- **자동 네트워크(패치로 차단):** registry/npm(버전), models.dev(가격표),
  `{baseUrl}/user/balance`(잔액), raw.githubusercontent + gh-proxy(추천),
  cdn.simpleicons.org(폴백 아이콘 → data-URI로 무력화).
- **사용자 클릭 링크(그대로 유지, 존재만으로 네트워크 아님):**
  `platform.deepseek.com/`·`/usage`, `github.com/.../releases/latest`,
  `models.dev/providers/…`, `platform.deepseek.com/usage`, 헤더/도움말 링크.
  이들은 `<a target=_blank>`/`href`로 렌더되며 브라우저가 사용자 조작 시에만 접근.
- **정적 문자열(fetch 없음):** `Wa='https://api.deepseek.com'`는 기본 **baseUrl 상수**(클로저 없음);
  실제 잔액 요청은 `Xa`를 거치므로 이미 차단됨. `raw.githubusercontent.com/…/main/`는
  원격 추천 icon URL의 `new URL(상대)` **base 문자열**(fetch 호출부 아님).

## 4. 改変範囲 (변경 범위) & after-patch hashes

| 파일 | upstream bytes | staged bytes | 변경 |
|---|---|---|---|
| `lib/index.js` | 177127 | 177812 | fetch 3 + icon 1 치환 |
| `lib/client.js` | 939437 | 939812 | icon 1 치환 |

`package.json` 외 나머지 staged files are byte-identical to upstream except for the
documented `lib/index.js` and `lib/client.js` network patches. No new runtime dependency
was added; zod remains the existing dependency at `4.6.6`.

### after-patch (staged) sha256
```
eb5bfa3a710cd3a95f1da1859d93374e8976cca75fa1b9aa393663a22a8b5240  lib/index.js
499cf778eaaba2b796f65d64dc01f55e06a8a61caa22022103bdbb3da2724c0e  lib/client.js
9e7004f827742b2db7e6c7e19e28d519e6c8dcba07427027146a9ff42a8bc7f8  scripts/offline-patch.mjs
cd9d353ff7eaf0623142448c38cec83321558ffe715f36c14fa469e421a77fef  scripts/test-offline-patch.mjs
```

(§1 원본·tarball 해시, §4 원복 대조용 staged 해시. 등록 전 `sha256sum`으로 대조.)

## 5. 재현·검증 명령

```bash
cd staged/dsh-context

# (1) 원본 upstream 원문자 정확 매치 횟수: fetch 3(index.js) + icon 2(index+client)
# (2) 패치 후 index.js fetch( = 0
# (3) node --check lib/index.js lib/client.js
# (4) node:vm 실제 차단검사: Xa/Gl/Qi-기본을 추출해 실행 → await rejects + 전역 fetch 스파이 호출 0
# (5) 정적 스캔: 차단 호스트 fetch 잔존 없음 / 신규 네트워크 프리미티브 없음
node scripts/offline-patch.mjs          # 멱등: 재실행 시 (already patched)로 skip
node scripts/test-offline-patch.mjs     # ALL PASS: 31 passed, 0 failed
```

`offline-patch.mjs`는 대상을 정확히 1회 발견 시에만 치환하고, 없거나 복수면 exit 1로
멈춥니다(원본 오타·드리프트 방지). `test-offline-patch.mjs`는 **외부 의존성 0**(Node
내장 `node:vm`/`node:child_process`만)이고 네트워크를 호출하지 않습니다.

## 6. 비용 관련 고지 — 외부 가격표 미조회

패치로 `models.dev/api.json`(가격표) 및 DeepSeek `/user/balance`(잔액) 조회가 모두
차단됩니다. 따라서 **로컬 Qwen 사용분(토큰·금액)을 이 플러그인 UI가 집계하지 못합니다.**
→ **비용은 "불명(unknown)"** 으로 표시되며, **0원(공짜)으로 단정하면 안 됩니다.** 실제
비용은 모델 게이트웨이/프로바이더 장부 기준으로 별도 확인이 필요합니다. 이 스테이징본은
비용 산정을 목표로 하지 않습니다.

## 7. 설치(운영자) / 롤백

**설치(운영자 실행 — 이 작업은 원본·프로필을 건드리지 않음):**
1. `staged/dsh-context/` 내용을 검토(§3·§4 diff, §5 테스트 ALL PASS 확인).
2. 프로필의 `local-plugins/dsh-context`로 복사.
3. 공식 `dsh` plugin으로 등록(운영자 판단).

**롤백:**
- `local-plugins/dsh-context`를 삭제(또는 등록 해제)하면 이 스테이징본 효과 제거.
- 원본 복원이 필요하면 수정 금지된 `upstream/package`를 그대로 재사용하거나
  `upstream/dsh-context-0.83.0.tgz`를 재추출(§1 sha256으로 무결성 확인).
- 스테이징 자체를 되돌리려면 `staged/dsh-context/lib/{index,client}.js`를
  `upstream/package`의 동일 파일로 덮어쓰면 원복됨(§1 해시와 대조).

**패치 스크립트 자체를 되돌리지 않고 다시 적용:** `scripts/offline-patch.mjs`는 멱등이며,
원본 lib을 복사 후 재실행하면 동일 결과(§5).
