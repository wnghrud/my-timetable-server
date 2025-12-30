const express = require("express");
const bodyParser = require("body-parser");
const Timetable = require("comcigan-parser");

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/api", apiRouter);

// --------------------
// Timetable Parser
// --------------------
const timetableParser = new Timetable();
let parserReady = false;

async function initParser() {
  if (parserReady) return;
  try {
    await timetableParser.init({ cache: 1000 * 60 * 30 }); // 30분 캐시
    const list = await timetableParser.search("불곡고");
    const school = list.find(s => s.name?.includes("불곡고")) || list[0];
    timetableParser.setSchool(school.code);
    parserReady = true;
    console.log("Parser ready:", school.name);
  } catch (err) {
    console.error("Parser init failed:", err);
    setTimeout(initParser, 60000); // 1분 후 재시도
  }
}

// 서버 시작 시 미리 초기화
initParser();

// --------------------
// Date helpers (KST 기준)
// --------------------
const DAYS = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
const DAY_INDEX = {
  "월요일": 0,
  "화요일": 1,
  "수요일": 2,
  "목요일": 3,
  "금요일": 4
};

function getKoreaDate(offset = 0) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  d.setDate(d.getDate() + offset);
  return d;
}

// --------------------
// API (내일만 가능)
// --------------------
apiRouter.post("/timeTable", async (req, res) => {
  if (!parserReady) {
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "⏳ 서버 준비 중입니다." } }] }
    });
  }

  try {
    const params = req.body.action?.params || {};
    const grade = parseInt(params.grade);
    const classroom = parseInt(params.classroom);
    const dayParam = params.day; // 반드시 "내일"

    // 검증
    if (!grade || !classroom) {
      return res.json({
        version: "2.0",
        template: { outputs: [{ simpleText: { text: "학년과 반을 입력해주세요." } }] }
      });
    }

    // 내일만 허용
    if (dayParam !== "내일") {
      return res.json({
        version: "2.0",
        template: { outputs: [{ simpleText: { text: "시간표는 내일만 조회할 수 있습니다." } }] }
      });
    }

    const date = getKoreaDate(1); // 내일
    const dayName = DAYS[date.getDay()];
    const idx = DAY_INDEX[dayName];

    if (idx === undefined) {
      return res.json({
        version: "2.0",
        template: { outputs: [{ simpleText: { text: `${dayName}에는 수업이 없습니다.` } }] }
      });
    }

    const full = await timetableParser.getTimetable();
    const schedule = full[grade]?.[classroom]?.[idx] || [];

    let text = `${dayName} — ${grade}학년 ${classroom}반 내일 시간표\n\n`;
    text += schedule.length === 0
      ? "수업이 없습니다!"
      : schedule.map(o => `${o.classTime}교시: ${o.subject}`).join("\n");

    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text } }] }
    });

  } catch (err) {
    console.error(err);
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "시간표 처리 중 오류 발생" } }] }
    });
  }
});

// --------------------
// Health check (Railway용)
// --------------------
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

// --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
