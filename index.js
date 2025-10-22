const express = require("express");
const bodyParser = require("body-parser");
const Timetable = require("comcigan-parser");

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 8080;

// JSON 파싱
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/api", apiRouter);

// Parser 준비 상태
const timetableParser = new Timetable();
let parserReady = false;

// 안전한 초기화 함수
async function initParser() {
  try {
    await timetableParser.init({ cache: 1000 * 60 * 30 }); // 30분 캐시
    const schoolList = await timetableParser.search("불곡고");

    if (!schoolList || schoolList.length === 0) {
      throw new Error("검색 결과 없음 (comcigan-parser)");
    }

    const target = schoolList.find(s => s.name && s.name.includes("불곡고")) || schoolList[0];
    timetableParser.setSchool(target.code);
    parserReady = true;
    console.log("✅ Parser ready for:", target.name || target.code);
  } catch (err) {
    console.error("❌ Parser 초기화 실패:", err);
    parserReady = false;
    setTimeout(() => {
      console.log("🔁 Parser 재초기화 시도...");
      initParser();
    }, 1000 * 60 * 1);
  }
}
initParser();

// ----------------------
// 오늘/내일 요일 헬퍼 (무조건 내일)
// ----------------------
function getTodayKorean(offset = 1) { // offset 무시, 항상 1
  const days = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  korea.setDate(korea.getDate() + 1); // 무조건 내일
  return days[korea.getDay()];
}

// 월~금 인덱스
function dayToIndex(dayKorean) {
  const map = { "월요일":0,"화요일":1,"수요일":2,"목요일":3,"금요일":4 };
  return map[dayKorean];
}

// 시간표 문자열 생성
function formatScheduleText(dayKorean, grade, classroom, scheduleArray) {
  let text = `${dayKorean} — ${grade}학년 ${classroom}반 시간표\n\n`;
  if (!scheduleArray || scheduleArray.length === 0) {
    text += "오늘은 수업이 없어요!";
  } else {
    text += scheduleArray.map(o => {
      const time = o.classTime || o.time || o.시간 || "";
      const subject = o.subject || o.name || o.과목 || "알 수 없는 과목";
      return `${time}교시: ${subject}`;
    }).join("\n");
  }
  return text;
}

// ======================
// 텍스트 시간표 API
// ======================
apiRouter.post("/timeTable", async (req, res) => {
  if (!parserReady) {
    return res.status(503).json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: "⚠️ 서버에서 시간표 파서를 준비 중입니다. 잠시 후 다시 시도해주세요." } }]
      }
    });
  }

  try {
    console.log("📥 Request Body:", JSON.stringify(req.body, null, 2));

    let grade = null;
    let classroom = null;
    let dayOffset = 1; // ✅ 테스트용 무조건 내일

    // action.params에서 학년/반 추출
    if (req.body.action?.params) {
      const g = parseInt(req.body.action.params.grade);
      const c = parseInt(req.body.action.params.classroom);
      if (!Number.isNaN(g)) grade = g;
      if (!Number.isNaN(c)) classroom = c;
    }

    // utterance에서 학년/반 추출 (예: "2학년 5반")
    const utteranceRaw = req.body.userRequest?.utterance || "";
    const utterance = String(utteranceRaw).toLowerCase();

    if (!grade || !classroom) {
      const matchKor = utterance.match(/([1-3])\s*학년\s*([1-9])\s*반/);
      if (matchKor) {
        grade = parseInt(matchKor[1]);
        classroom = parseInt(matchKor[2]);
      } else {
        const matchNum = utterance.match(/([1-3])\s*[-\/,]\s*([1-9])/);
        if (matchNum) {
          grade = parseInt(matchNum[1]);
          classroom = parseInt(matchNum[2]);
        } else {
          const matchSpace = utterance.match(/\b([1-3])\s+([1-9])\b/);
          if (matchSpace) {
            grade = parseInt(matchSpace[1]);
            classroom = parseInt(matchSpace[2]);
          }
        }
      }
    }

    // 학년/반 누락 시 안내
    if (!grade || grade < 1 || grade > 3 || !classroom || classroom < 1 || classroom > 9) {
      return res.status(200).json({
        version: "2.0",
        template: {
          outputs: [
            { simpleText: { text: "❌ 학년과 반 정보를 올바르게 입력해주세요. 예: '2학년 5반' 또는 '2-5'." } }
          ]
        }
      });
    }

    // 날짜 계산
    const dayKorean = getTodayKorean(); // 무조건 내일
    const idx = dayToIndex(dayKorean);

    if (idx === undefined) {
      return res.status(200).json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: `${dayKorean}은 수업이 없습니다!` } }]
        }
      });
    }

    // 시간표 가져오기
    const full = await timetableParser.getTimetable();
    const scheduleArray = full[grade]?.[classroom]?.[idx] || [];

    const text = formatScheduleText(dayKorean, grade, classroom, scheduleArray);

    return res.status(200).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text } }] }
    });

  } catch (err) {
    console.error("시간표 응답 에러:", err);
    return res.status(500).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "❌ 시간표를 처리하는 중 오류가 발생했습니다." } }] }
    });
  }
});

// 헬스체크
app.get("/healthz", (req, res) => res.send("OK"));

// 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 Skill server listening on port ${PORT}`);
});
