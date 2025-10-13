const express = require("express");
const bodyParser = require("body-parser");
const Timetable = require("comcigan-parser");

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/api", apiRouter);

const timetableParser = new Timetable();
async function initParser() {
  try {
    await timetableParser.init({ cache: 1000 * 60 * 30 });
    const schoolList = await timetableParser.search("불곡고");
    const target = schoolList.find(s => s.name.includes("불곡고"));
    if (!target) throw new Error("불곡고를 컴시간에서 찾을 수 없음");
    timetableParser.setSchool(target.code);
    console.log("Parser initialized. 학교 설정 완료.");
  } catch (err) {
    console.error("Parser 초기화 실패:", err);
  }
}
initParser();

function getTodayKorean() {
  const days = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  return days[new Date().getDay()];
}

function dayToIndex(dayKorean) {
  const map = { "월요일":0,"화요일":1,"수요일":2,"목요일":3,"금요일":4 };
  return map[dayKorean];
}

apiRouter.post("/timeTable", async (req, res) => {
  try {
    console.log("Request Body:", JSON.stringify(req.body, null, 2));

    let classroom = parseInt(req.body.action?.params?.classroom);
    let grade = parseInt(req.body.action?.params?.grade);

    if (!grade || grade < 1 || grade > 3) grade = 2;
    if (!classroom || classroom < 1 || classroom > 9) classroom = 5;

    const today = getTodayKorean();
    const idx = dayToIndex(today);
    const full = await timetableParser.getTimetable();
    const todaySchedule = (full[grade]?.[classroom]?.[idx] || []);

    let text = `${today} — ${grade}학년 ${classroom}반 시간표\n\n`;
    if (todaySchedule.length === 0) text += "오늘은 수업이 없어요!";
    else text += todaySchedule.map(o => `${o.classTime}교시: ${o.subject}`).join("\n");

    res.json({ version: "2.0", template: { outputs: [{ simpleText: { text } }] } });

  } catch (err) {
    console.error("시간표 응답 에러:", err);
    res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "시간표를 불러오는 중 오류가 발생했어요." } }] } });
  }
});

app.listen(PORT, () => {
  console.log(`Skill server listening on port ${PORT}`);
});
