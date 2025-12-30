const express = require("express");
const bodyParser = require("body-parser");
const Timetable = require("comcigan-parser");
const morgan = require("morgan");

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 8080;

// --------------------
// Middleware
// --------------------
app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/api", apiRouter);

// --------------------
// Timetable Parser
// --------------------
const timetableParser = new Timetable();
let parserReady = false;

// 캐시
let cachedTimetable = null;
let cachedAt = 0;
const CACHE_TTL = 1000 * 60 * 10; // 10분

async function initParser() {
  try {
    console.log("⏳ 시간표 파서 초기화 중...");
    await timetableParser.init({ cache: 1000 * 60 * 30 });

    const schoolList = await timetableParser.search("불곡고");
    if (!schoolList || schoolList.length === 0) {
      throw new Error("학교 검색 실패");
    }

    const target =
      schoolList.find(s => s.name?.includes("불곡고")) || schoolList[0];

    timetableParser.setSchool(target.code);
    parserReady = true;

    console.log("✅ 파서 준비 완료:", target.name);
  } catch (err) {
    console.error("❌ 파서 초기화 실패:", err);
    parserReady = false;
    setTimeout(initParser, 1000 * 60);
  }
}

initParser();

// --------------------
// Helpers
// --------------------
function getTodayKorean() {
  const days = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
  return days[now.getDay()];
}

function dayToIndex(dayKorean) {
  const map = { 월요일:0, 화요일:1, 수요일:2, 목요일:3, 금요일:4 };
  return map[dayKorean];
}

async function getCachedTimetable() {
  const now = Date.now();
  if (!cachedTimetable || now - cachedAt > CACHE_TTL) {
    console.log("⏳ 시간표 캐시 새로 로딩");
    cachedTimetable = await timetableParser.getTimetable();
    cachedAt = now;
  }
  return cachedTimetable;
}

// --------------------
// API
// --------------------
apiRouter.post("/timeTable", async (req, res) => {
  if (!parserReady) {
    return res.json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: "시간표를 준비 중입니다. 잠시만 기다려주세요 🙏" } }
        ]
      }
    });
  }

  try {
    let grade, classroom;

    if (req.body.action?.params) {
      grade = parseInt(req.body.action.params.grade);
      classroom = parseInt(req.body.action.params.classroom);
    }

    if (!grade || !classroom) {
      const utterance = req.body.userRequest?.utterance || "";
      const match = utterance.match(
        /([1-3])\s*학년\s*([1-9])\s*반|([1-3])\s*[-\/]\s*([1-9])/
      );
      if (match) {
        grade = parseInt(match[1] || match[3]);
        classroom = parseInt(match[2] || match[4]);
      }
    }

    if (!grade || !classroom) {
      return res.json({
        version: "2.0",
        template: {
          outputs: [
            { simpleText: { text: "학년과 반을 입력해주세요. 예: 2학년 5반" } }
          ]
        }
      });
    }

    const dayKorean = getTodayKorean();
    const dayIndex = dayToIndex(dayKorean);

    if (dayIndex === undefined) {
      return res.json({
        version: "2.0",
        template: {
          outputs: [
            { simpleText: { text: `${dayKorean}은 수업이 없습니다.` } }
          ]
        }
      });
    }

    const full = await getCachedTimetable();
    const schedule = full?.[grade]?.[classroom]?.[dayIndex] || [];

    const text =
`${dayKorean} ${grade}학년 ${classroom}반 시간표

${schedule.length === 0
  ? "수업 정보가 없습니다."
  : schedule.map((s, i) => `${i + 1}교시: ${s.subject || "과목 없음"}`).join("\n")}`;

    return res.json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text } }]
      }
    });

  } catch (err) {
    console.error(err);
    return res.json({
      version: "2.0",
      template: {
        outputs: [
          { simpleText: { text: "시간표 처리 중 오류가 발생했습니다." } }
        ]
      }
    });
  }
});

// --------------------
// Health Check
// --------------------
app.get("/healthz", (req, res) => res.send("OK"));

// --------------------
// Start
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
