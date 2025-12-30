const express = require("express");
const bodyParser = require("body-parser");
const Timetable = require("comcigan-parser");

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 8080;

// --------------------
// Middleware
// --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/api", apiRouter);

// --------------------
// Timetable Parser
// --------------------
const timetableParser = new Timetable();
let parserReady = false;

async function initParser() {
  try {
    await timetableParser.init({ cache: 1000 * 60 * 30 });
    const schoolList = await timetableParser.search("불곡고");
    const target =
      schoolList.find(s => s.name?.includes("불곡고")) || schoolList[0];

    timetableParser.setSchool(target.code);
    parserReady = true;
    console.log("Parser ready:", target.name);
  } catch (err) {
    console.error("Parser init failed:", err);
    setTimeout(initParser, 60_000);
  }
}
initParser();

// --------------------
// Date Helpers (KST)
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
// API
// --------------------
apiRouter.post("/timeTable", async (req, res) => {
  if (!parserReady) {
    return res.status(200).json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: "⏳ 서버 준비 중입니다. 잠시 후 다시 시도해주세요." } }]
      }
    });
  }

  try {
    console.log("📥", JSON.stringify(req.body, null, 2));

    let grade, classroom;

    // 1️⃣ params
    if (req.body.action?.params) {
      grade = parseInt(req.body.action.params.grade);
      classroom = parseInt(req.body.action.params.classroom);
    }

    // 2️⃣ utterance
    const utterance = (req.body.userRequest?.utterance || "").toLowerCase();

    if (!grade || !classroom) {
      let m =
        utterance.match(/([1-3])\s*학년\s*([1-9])\s*반/) ||
        utterance.match(/([1-3])\s*[-\/,]\s*([1-9])/);

      if (m) {
        grade = parseInt(m[1]);
        classroom = parseInt(m[2]);
      }
    }

    if (!grade || !classroom) {
      return res.status(200).json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: "❌ 학년과 반을 입력해주세요. 예: 2-5, 2학년 5반" } }]
        }
      });
    }

    // --------------------
    // 오늘 / 내일 판단
    // --------------------
    let dayOffset = 0; // 기본 오늘
    if (utterance.includes("내일")) dayOffset = 1;

    const targetDate = getKoreaDate(dayOffset);
    const dayName = DAYS[targetDate.getDay()];
    const idx = DAY_INDEX[dayName];

    if (idx === undefined) {
      return res.status(200).json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: `${dayName}에는 수업이 없어요 📭` } }]
        }
      });
    }

    const full = await timetableParser.getTimetable();
    const schedule = full[grade]?.[classroom]?.[idx] || [];

    let text = `${dayName} — ${grade}학년 ${classroom}반 시간표\n\n`;

    if (schedule.length === 0) {
      text += "수업이 없습니다!";
    } else {
      text += schedule
        .map(o => `${o.classTime}교시: ${o.subject}`)
        .join("\n");
    }

    return res.status(200).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text } }] }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: "⚠️ 시간표 처리 중 오류가 발생했습니다." } }]
      }
    });
  }
});

// --------------------
// Health Check
// --------------------
app.get("/healthz", (_, res) => res.send("OK"));

// --------------------
app.listen(PORT, () => {
  console.log(`Skill server listening on port ${PORT}`);
});
