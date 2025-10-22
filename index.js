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

    // '불곡고'가 포함된 항목을 우선으로, 없으면 첫 번째 결과 사용
    const target = schoolList.find(s => s.name && s.name.includes("불곡고")) || schoolList[0];
    timetableParser.setSchool(target.code);
    parserReady = true;
    console.log("✅ Parser ready for:", target.name || target.code);
  } catch (err) {
    console.error("❌ Parser 초기화 실패:", err);
    parserReady = false;
    // 초기화를 재시도하도록 타이머 등록 (옵션)
    setTimeout(() => {
      console.log("🔁 Parser 재초기화 시도...");
      initParser();
    }, 1000 * 60 * 1); // 1분 후 재시도
  }
}
initParser();

// ----------------------
// 시간/요일 헬퍼 (UTC -> KST 수동 변환)
// ----------------------
function getTodayKorean(offset = 0) {
  const days = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  const now = new Date();
  // 한국시간 = UTC + 9시간
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  korea.setDate(korea.getDate() + offset);
  // getUTCDay on the shifted time gives correct KST weekday
  return days[korea.getUTCDay()];
}

// 월~금을 0..4로 매핑, 주말이면 undefined 반환
function dayToIndex(dayKorean) {
  const map = { "월요일":0,"화요일":1,"수요일":2,"목요일":3,"금요일":4 };
  return map[dayKorean];
}

// 시간표 텍스트 생성 유틸
function formatScheduleText(dayKorean, grade, classroom, scheduleArray) {
  let text = `${dayKorean} — ${grade}학년 ${classroom}반 시간표\n\n`;
  if (!scheduleArray || scheduleArray.length === 0) {
    text += "오늘은 수업이 없어요!";
  } else {
    // scheduleArray 항목의 구조는 comcigan-parser 출력에 따름.
    // 안전하게 접근하여 classTime과 subject를 사용
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
  // 카카오 webhook 형식으로 응답(같은 구조 유지)
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
    let dayOffset = 0; // 0 = 오늘, 1 = 내일

    // 1) action.params에서 우선 추출 (카카오 action 파라미터)
    if (req.body.action?.params) {
      // 숫자로 변환 시 NaN 방지를 위해 parseInt 후 유효성 검사
      const g = parseInt(req.body.action.params.grade);
      const c = parseInt(req.body.action.params.classroom);
      if (!Number.isNaN(g)) grade = g;
      if (!Number.isNaN(c)) classroom = c;

      if (req.body.action.params.day === "tomorrow") dayOffset = 1;
    }

    // 2) utterance에서 학년/반/내일 추출 (사용자 발화)
    const utteranceRaw = req.body.userRequest?.utterance || "";
    const utterance = String(utteranceRaw).toLowerCase();

    // 학년/반 한국어 표현 추출 (예: "2학년 5반")
    if (!grade || !classroom) {
      const matchKor = utterance.match(/([1-3])\s*학년\s*([1-9])\s*반/);
      if (matchKor) {
        grade = parseInt(matchKor[1]);
        classroom = parseInt(matchKor[2]);
      } else {
        // 숫자 표기: "2-5", "2/5", "2,5" 등
        const matchNum = utterance.match(/([1-3])\s*[-\/,]\s*([1-9])/);
        if (matchNum) {
          grade = parseInt(matchNum[1]);
          classroom = parseInt(matchNum[2]);
        } else {
          // 또 다른 가능 성: "2 5" 같은 경우
          const matchSpace = utterance.match(/\b([1-3])\s+([1-9])\b/);
          if (matchSpace) {
            grade = parseInt(matchSpace[1]);
            classroom = parseInt(matchSpace[2]);
          }
        }
      }
    }

    // "내일" 키워드 감지 (utterance가 우선)
    if (utterance.includes("내일")) dayOffset = 1;

    // 입력 검증
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

    // 날짜 계산 (모든 입력 처리 후)
    const dayKorean = getTodayKorean(dayOffset);
    const idx = dayToIndex(dayKorean);
    console.log(`🗓 요청: grade=${grade}, class=${classroom}, dayOffset=${dayOffset}, day=${dayKorean}, idx=${idx}`);

    // 주말 처리
    if (idx === undefined) {
      return res.status(200).json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: `${dayKorean}은 수업이 없습니다!` } }]
        }
      });
    }

    // 시간표 가져오기 (comcigan-parser가 반환하는 형태에 따라 안전하게 접근)
    let full = null;
    try {
      full = await timetableParser.getTimetable(); // 기존 예제와 동일 사용
    } catch (err) {
      console.error("comcigan-parser getTimetable 호출 에러:", err);
      return res.status(200).json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: "⚠️ 시간표를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." } }]
        }
      });
    }

    // full의 구조는 lib 버전에 따라 다를 수 있으므로 안전 접근
    // 기대 구조: full[grade][classroom][idx] => 배열
    const scheduleArray = (full && full[grade] && full[grade][classroom] && full[grade][classroom][idx]) || [];

    const text = formatScheduleText(dayKorean, grade, classroom, scheduleArray);

    return res.status(200).json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text } }] }
    });

  } catch (err) {
    console.error("시간표 응답 에러:", err);
    return res.status(200).json({
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
