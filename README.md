# 하츠의 마비노기 — 정적 사이트 + 경매장 시세 자동 갱신

GitHub Pages에 올리면 `https://<아이디>.github.io/<저장소>/` 주소로 열려요.
경매장 시세는 GitHub Actions가 매시간 NEXON Open API를 불러 `prices.json`을 갱신해요. API 키는 저장소 Secret에만 두고 페이지에는 들어가지 않아요.

## 1. 저장소 만들기
1. GitHub에서 새 저장소(Public)를 만들어요. 예: `hatz-mabinogi`
2. 이 폴더의 파일을 모두 올려요. (`.github` 폴더와 `.nojekyll` 파일도 꼭 포함)

## 2. GitHub Pages 켜기
Settings › Pages › Build and deployment › Source: **Deploy from a branch**, Branch: **main / (root)** › Save

## 3. API 키 등록 (Secret)
Settings › Secrets and variables › Actions › **New repository secret**
- Name: `NEXON_API_KEY`
- Secret: NEXON Open API에서 발급받은 키

## 4. 시세 갱신 확인
Actions 탭 › **경매장 시세 갱신** › **Run workflow**로 한 번 실행해요.
성공하면 `prices.json`의 `updatedAt`과 `items`가 채워지고, 세팅 시뮬레이터 인형 가방 가격에 반영돼요. 이후에는 매시 17분(UTC)에 자동 실행돼요.

## 5. NEXON Open API 서비스 등록
넥슨 Open API 애플리케이션의 서비스 주소에 Pages 주소를 등록해요.
모든 페이지 `<head>`에 애널리틱스 스크립트(`app_id=347863`)가 이미 들어가 있어요.

## 시세 대상 바꾸기
`prices.json`
- `watch`: 정확한 아이템 이름 (auction/list로 조회)
- `keywords`: 키워드 (auction/keyword-search로 조회 · 검색된 아이템 이름별 최저가 저장)

## 참고
- 캐릭터 정보는 브라우저(localStorage)에 저장돼요. claude.ai 아티팩트에서 입력한 데이터는 새 주소로 넘어오지 않아요.
- 화면 너비 768px 미만이면 모바일 페이지로, 1024px 이상이면 데스크톱 페이지로 자동 이동해요.
- Data based on NEXON Open API.
