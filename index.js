const express = require("express");
const Timetable = require("comcigan-parser");
const morgan = require("morgan");

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 8080;

// --------------------
// Middleware (express 내장 함수 사용으로 body-parser 의존성 제거)
// --------------------
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", apiRouter);

// --------------------
// Timetable Parser Configuration
// --------------------
const timetableParser = new Timetable();
let parserReady = false;

// 캐시 저장소 및 설정
let cachedTimetable = null;
let cachedAt = 0;
const CACHE_TTL = 1000 * 60 * 10; // 10분 캐시 유지

/**
 * 컴포넌트 실행 시 파서를 초기화하고 학교 정보를 설정하는 함수
 */
async function initParser() {
  try {
    console.log("⏳ 시간표 파서 초기화 중...");
    // comcigan-parser 기본 초기화 (내부 컴포지션 설정 캐시 시간 부여)
    await timetableParser.init({ cache: 1000 * 60 * 30 });

    const schoolList = await timetableParser.search("불곡고");
    if (!schoolList || schoolList.length === 0) {
      throw new Error("학교 검색 결과가 존재하지 않습니다.");
    }

    // 정확한 학교 검색 매칭 혹은 첫 번째 검색 결과 채택
    const target = schoolList.find(s => s.name?.includes("불곡고")) || schoolList[0];

    await timetableParser.setSchool(target.code);
    parserReady = true;

    console.log(`✅ 파서 준비 완료 대상 학교: ${target.name} (${target.code})`);
  } catch (err) {
    console.error("❌ 파서 초기화 중 에러 발생:", err.message);
    parserReady = false;
    // 실패 시 1분 뒤 안전하게 재시도 루프 활성화
    setTimeout(initParser, 1000 * 60);
  }
}

// 애플리케이션 시작 시 초기화 구동
initParser();

// --------------------
// Helper Functions
// --------------------
/**
 * 한국 시간대 기준으로 내일 요일을 텍스트로 반환
 */
function getTomorrowKorean() {
  const days = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return days[tomorrow.getDay()];
}

/**
 * 한글 요일 명칭을 컴시간 인덱스로 변환 (월: 0 ~ 금: 4)
 */
function dayToIndex(dayKorean) {
  const map = { "월요일": 0, "화요일": 1, "수요일": 2, "목요일": 3, "금요일": 4 };
  return map[dayKorean];
}

/**
 * 캐시 만료 여부를 검사하여 신규 시간표 데이터를 반환하는 안전 함수
 */
async function getCachedTimetable() {
  const now = Date.now();
  if (!cachedTimetable || now - cachedAt > CACHE_TTL) {
    console.log("⏳ 시간표 캐시 만료 혹은 유실로 인한 새로고침 진행");
    cachedTimetable = await timetableParser.getTimetable();
    cachedAt = now;
  }
  return cachedTimetable;
}

// --------------------
// Kakao Chatbot API Router
// --------------------
apiRouter.post("/timeTable", async (req, res) => {
  // 1. 파서 미준비 시 방어 코드 처리
  if (!parserReady) {
    return res.json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: "서버가 시간표 데이터를 동기화하는 중입니다. 잠시 후 다시 시도해 주세요. 🙏" } }
        ]
      }
    });
  }

  try {
    let grade = null;
    let classroom = null;

    // 2. 카카오톡 엔티티/파라미터 추출 시도
    if (req.body.action?.params) {
      if (req.body.action.params.grade) grade = parseInt(req.body.action.params.grade, 10);
      if (req.body.action.params.classroom) classroom = parseInt(req.body.action.params.classroom, 10);
    }

    // 3. 파라미터가 비어있을 시 일반 발화 텍스트 정규식 분석 보완
    if (!grade || !classroom) {
      const utterance = req.body.userRequest?.utterance || "";
      const match = utterance.match(/([1-3])\s*학년\s*([1-9][0-2]?)\s*반|([1-3])\s*[-\/]\s*([1-9][0-2]?)/);
      if (match) {
        grade = parseInt(match[1] || match[3], 10);
        classroom = parseInt(match[2] || match[4], 10);
      }
    }

    // 4. 학년 및 반 유효성 검증 예외 처리
    if (!grade || !classroom) {
      return res.json({
        version: "2.0",
        template: {
          outputs: [
            { simpleText: { text: "정확한 학년과 반을 파악하지 못했습니다.\n예시: '2학년 5반 시간표 알려줘'와 같이 입력해 주세요." } }
          ]
        }
      });
    }

    const dayKorean = getTomorrowKorean();
    const dayIndex = dayToIndex(dayKorean);

    // 5. 주말(토, 일) 수업 예외 처리
    if (dayIndex === undefined) {
      return res.json({
        version: "2.0",
        template: {
          outputs: [
            { simpleText: { text: `안내해 드릴 내일(${dayKorean}) 수업 정보가 존재하지 않는 주말입니다. 편안한 시간 되세요! 🎉` } }
          ]
        }
      });
    }

    // 6. 데이터베이스/캐싱 시간표 조회
    const full = await getCachedTimetable();
    const schedule = full?.[grade]?.[classroom]?.[dayIndex] || [];

    // 7. 출력용 응답 메시지 빌드
    const scheduleText = schedule.length === 0
      ? "등록된 정규 수업 정보가 없습니다."
      : schedule.map((s, i) => `${i + 1}교시: ${s.subject || "과목 정보 없음"}`).join("\n");

    const text = `📅 내일(${dayKorean}) ${grade}학년 ${classroom}반 시간표 결과입니다.\n\n${scheduleText}`;

    return res.json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text } }]
      }
    });

  } catch (err) {
    console.error("❌ 시간표 조회 라우터 런타임 오류:", err);
    return res.json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: "시간표를 가져오는 과정에서 내부 처리에 일시적인 오류가 발생했습니다. 다시 시도해 주세요." } }
        ]
      }
    });
  }
});

// --------------------
// Health Check Endpoint
// --------------------
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// --------------------
// Server Listener Activation
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 내일 시간표 알리미 서버가 포트 ${PORT}번에서 정상 작동 중입니다.`);
});
