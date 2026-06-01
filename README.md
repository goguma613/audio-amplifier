# 🔊 브라우저 소리 증폭기 (Audio Amplifier)

영상/오디오 소리가 너무 작을 때, 브라우저에서 **최대 500%까지** 소리를 키워주는 유저스크립트입니다.
브라우저·OS 볼륨의 100% 한계를 넘어 소프트웨어로 증폭합니다.
(Tampermonkey · Violentmonkey 등 유저스크립트 매니저에서 동작)

## ✨ 기능

- **소리 증폭** — 100% ~ 500% 슬라이더 조절
- **클리핑 방지 리미터** — 소리를 키워도 심하게 찢어지지 않게 자동 제어
- **VU미터 + 클리핑 경고** — 음량을 시각적으로 보여주고, 너무 키우면 빨갛게 점멸
- **3밴드 EQ + 음성 부스트** — 저/중/고음 조절, 대사가 잘 안 들릴 때 "음성 부스트" 한 번 클릭
- **사이트별 설정 기억** — 유튜브는 200%, 다른 곳은 150% 등 도메인마다 따로 저장
- **드래그 이동 / 접기** — 시청에 방해되지 않게 위치 이동, 작은 핀으로 접기
- **자동 영상 감지** — 유튜브처럼 페이지 이동 없이 영상이 바뀌어도 자동 적용

## 🚀 설치 방법 (2단계)

> Chrome·Whale(네이버) 모두 동일하게 동작합니다. (둘 다 크롬 확장 호환)

### 1단계 — 유저스크립트 매니저 설치
유저스크립트를 실행해주는 확장 프로그램이에요. **둘 중 아무거나** 설치하면 되고, 이 증폭기는 둘 다에서 똑같이 동작합니다.

- **추천 → [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)** — 사용자가 가장 많고 최신 규격(Manifest V3) 대응이 안정적입니다.
- 대안 → [Violentmonkey](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag) (오픈소스)

크롬 웹스토어에서 **"Chrome에 추가"** 클릭. **Whale 사용자**도 위 링크로 바로 설치됩니다. (웨일 설정 → 확장앱에서 "다른 스토어의 확장앱 설치 허용"이 필요할 수 있어요)

> ⚠️ **개발자 모드 안내**: 최신 크롬/웨일(Manifest V3)에서는 유저스크립트 매니저가 동작하려면 **개발자 모드**를 한 번 켜야 합니다(Tampermonkey·Violentmonkey 공통, 크롬 정책). 설치 후 확장이 안내해주는 대로 `chrome://extensions`(웨일은 `whale://extensions`) 우측 상단의 **개발자 모드** 토글을 켜주세요. 한 번만 하면 됩니다.

### 2단계 — 증폭기 스크립트 설치
아래 링크를 클릭하면 유저스크립트 설치 화면이 뜹니다. **"설치"** 버튼만 누르면 끝!

👉 **[증폭기 설치하기](https://raw.githubusercontent.com/goguma613/audio-amplifier/main/audio-amplifier.user.js)**

> 또는 설치 안내 페이지: **https://goguma613.github.io/audio-amplifier/**

## 🎮 사용법

1. 유튜브 등 영상 사이트에 가면 우측 상단에 🔊 패널이 나타납니다.
2. 슬라이더를 올려 소리를 키우세요.
3. 대사가 안 들리면 **🎙 음성 부스트** 버튼을 누르세요.
4. 패널이 거슬리면 **—** 버튼으로 작게 접을 수 있어요.
5. 설정은 사이트별로 자동 저장됩니다.

## ⚠️ 지원/미지원

| 구분 | 사이트 |
|------|--------|
| ✅ 지원 | YouTube, Twitch, Vimeo, 네이버 TV, 카카오 TV, 치지직, 아프리카TV, 일반 영상 사이트 |
| ❌ 미지원 | **Netflix·Disney+ 등 DRM 보호 영상** (기술적으로 Web Audio가 소리를 가로챌 수 없음) |

> 교차 출처(CORS) 제한이 있는 일부 영상은 자동으로 원음 재생으로 되돌아갑니다(무음 방지).

## 🔄 자동 업데이트

유저스크립트 매니저가 주기적으로 새 버전을 확인해 자동으로 업데이트합니다. 별도 작업이 필요 없습니다.

## 🛠 만든 사람을 위한 메모

- 코드는 단일 파일 `audio-amplifier.user.js` 안에 모듈(ConfigManager / AudioEngine / VideoObserver / UIManager)로 분리되어 있습니다.
- 배포: 이 저장소를 **공개**로 두고, 코드 수정 → `@version` 올림 → push 하면 사용자에게 자동 반영됩니다.
- `@updateURL` / `@downloadURL` / 링크 안의 `goguma613/audio-amplifier` 를 실제 GitHub 사용자명/저장소명으로 바꿔주세요.
