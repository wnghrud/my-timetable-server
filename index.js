const express = require("express");
const bodyParser = require("body-parser");
const Timetable = require("comcigan-parser");

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 5000;

// JSON 파싱
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/api", apiRouter);

// 컴시간 파서 초기화
const timetableParser = new Timetable();
let parserReady = false;
async function initParser() {
  try {
    await timetableParser.init({ cache: 1000 * 60 * 30 }); // 30분 캐시
    const schoolList = await timetableParser.search("불곡고");
    const target = schoolList.find(s => s.name.includes("불곡고"));
    if (!target) throw new Error("불곡고를 컴시간에서 찾을 수 없음");
    timetableParser.setSchool(target.code);
    parserReady = true;
    console.log("Parser initialized. 학교 설정 완료.");
  } catch (err) {
    console.error("Parser 초기화 실패:", err);
  }
}
initParser();

// helper: 오늘/내일 요일 한글
function getDayKorean(offset = 0) {
  const days = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  const today = new Date();
  today.setDate(today.getDate() + offset);
  return days[today.getDay()];
}

// helper: 요일 → 인덱스
function dayToIndex(dayKorean) {
  const map = { "월요일":0,"화요일":1,"수요일":2,"목요일":3,"금요일":4 };
  return map[dayKorean];
}

// ======================
// 텍스트 시간표 API
// ======================
apiRouter.post("/timeTable", async (req, res) => {
  if (!parserReady) {
    return res.status(503).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "⚠️ 서버 초기화 중입니다. 잠시 후 다시 시도해주세요." } }] }
    });
  }

  try {
    console.log("📥 Request Body:", JSON.stringify(req.body, null, 2));

    let grade = null;
    let classroom = null;
    let dayOffset = 0; // 0=오늘, 1=내일

    const utterance = (req.body.userRequest?.utterance || "").trim();

    // 1) 내일 포함 여부
    if (/내일/.test(utterance)) dayOffset = 1;

    // 2) params에서 가져오기
    if (req.body.action?.params) {
      grade = parseInt(req.body.action.params.grade);
      classroom = parseInt(req.body.action.params.classroom);
    }

    // 3) utterance에서 학년/반 추출
    if (!grade || !classroom) {
      const matchKor = utterance.match(/([1-3])\s*학년\s*([1-9])\s*반/);
      const matchNum = utterance.match(/([1-3])[\/\-,]([1-9])/);
      const match = matchKor || matchNum;
      if (match) {
        grade = parseInt(match[1]);
        classroom = parseInt(match[2]);
      }
    }

    // 유효하지 않으면 안내 메시지
    if (!grade || grade < 1 || grade > 3 || !classroom || classroom < 1 || classroom > 9) {
      return res.status(200).json({
        version: "2.0",
        template: {
          outputs: [
            { simpleText: { text: "❌ 학년과 반 정보를 올바르게 입력해주세요. 예: 2학년 5반, 2-5" } }
          ]
        }
      });
    }

    const dayKorean = getDayKorean(dayOffset);
    const idx = dayToIndex(dayKorean);

    const full = await timetableParser.getTimetable();
    const todaySchedule = full[grade]?.[classroom]?.[idx] || [];

    let text = `${dayOffset === 1 ? "내일" : "오늘"} ${dayKorean} — ${grade}학년 ${classroom}반 시간표\n\n`;
    if (todaySchedule.length === 0) text += "수업이 없어요!";
    else text += todaySchedule.map(o => `${o.classTime}교시: ${o.subject}`).join("\n");

    return res.status(200).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text } }] }
    });

  } catch (err) {
    console.error("시간표 응답 에러:", err);
    return res.status(200).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "⚠️ 시간표를 불러오는 중 오류가 발생했어요." } }] }
    });
  }
});

app.get('/healthz', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`Skill server listening on port ${PORT}`);
