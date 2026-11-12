# Code Map

AI로 만든 코드의 구조를 한눈에 보여 주는 웹 서비스입니다. 프로젝트 폴더를 열면 파일끼리 어떻게 연결되어 있는지 그래프로 보여 주고, 오류가 나기 쉬운 곳을 표시합니다. 고칠 파일만 골라 AI에게 보낼 프롬프트도 만들어 주므로 토큰을 아낄 수 있습니다.

## 기능
- **의존성 그래프**: JS/TS(React), Python, Java 파일의 import 관계, 폴더별 묶기
- **유지보수 위험 표시**: 영향 범위가 큰 파일, 순환 의존, 큰 파일, 안 쓰는 코드
- **git 커밋 비교**: 두 커밋 사이의 새 파일, 바뀐 파일, 새 연결, 새 위험
- **React 컴포넌트 트리**
- **AI 설명 (Gemini)**: 폴더 역할·파일 역할 설명, 변경 내용 한 줄 요약
- **🛠 AI 수정 요청 프롬프트**: 선택한 파일과 연결된 파일만 담은 프롬프트, 전체 코드 대비 토큰 절약량 표시

코드는 브라우저 안에서만 분석됩니다. AI 버튼을 누를 때만 코드 일부가 Google Gemini로 전송됩니다.

## 실행
```bash
npm install
cp .env.example .env.local   # GEMINI_API_KEY 입력 (AI 기능용)
npm run dev
```

## 배포 (Vercel)
`api/gemini.js`가 서버 함수로 Gemini 요청을 중계합니다. Vercel 프로젝트의 환경 변수에 `GEMINI_API_KEY`를 설정하세요. 키는 브라우저 코드에 포함되지 않습니다.

## 테스트
```bash
node src/analyze.test.js && node src/ai.test.js && node src/prompt.test.js
```
