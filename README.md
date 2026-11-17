# onlyMePriceLimit
나 혼자만 상한가 주식종목 기록 및 추천. (게임 내 추천)

## 실행

저장소 루트에서 아래 명령을 실행하고 `http://127.0.0.1:8000/`을 열면 됩니다.

```sh
python -m http.server 8000 --bind 127.0.0.1
```

GitHub Pages는 저장소의 **Settings → Pages**에서 **Deploy from a branch**를 선택하고, 소스를 **main** 브랜치의 **/(root)**로 지정합니다. [GitHub Pages 게시 소스 설정](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

주가는 이 사이트를 열어 사용한 브라우저에 저장됩니다. 로컬에서 입력한 기록을 GitHub Pages로 옮기려면 **데이터 편집 → 백업 내보내기**로 받은 JSON을 게시된 주소에서 **백업 복원**합니다. 복원하면 해당 브라우저의 종목과 월별 가격 전체가 백업으로 교체됩니다.
