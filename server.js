const admin = require("firebase-admin");
const express = require("express");

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://shemwave-f1d00-default-rtdb.firebaseio.com",
});

const db = admin.database();
const app = express();
const PORT = process.env.PORT || 3000;

/* ================================================================
   TIMEZONE CONFIG — IST is UTC+5:30
================================================================ */
const USER_TIMEZONE = "Asia/Kolkata";

const getNowInUserTZ = () => {
  const now = new Date();
  const tzString = now.toLocaleString("en-US", { timeZone: USER_TIMEZONE });
  const tzDate = new Date(tzString);
  return {
    hour: tzDate.getHours(),
    minute: tzDate.getMinutes(),
    day: tzDate.getDay(),
    fullTime: `${String(tzDate.getHours()).padStart(2, "0")}:${String(tzDate.getMinutes()).padStart(2, "0")}`,
  };
};

/* ================================================================
   IN-MEMORY SCHEDULE CACHE
================================================================ */
const schedulesCache = {};

/* ================================================================
   HELPER — is schedule due right now?
================================================================ */
const isScheduleDue = (schedule) => {
  const { hour, minute, day, fullTime } = getNowInUserTZ();

  const timePart = schedule.dateTime.includes("T")
    ? schedule.dateTime.split("T")[1].slice(0, 5)
    : schedule.dateTime.slice(0, 5);

  const [schedHour, schedMinute] = timePart.split(":").map(Number);

  console.log(
    `[CHECK] "${schedule.applianceName}": serverIST=${fullTime} scheduled=${timePart} repeat=${schedule.repeat}`
  );

  const nowTotalMins = hour * 60 + minute;
  const schedTotalMins = schedHour * 60 + schedMinute;
  const diff = nowTotalMins - schedTotalMins;

  const timeMatches = diff >= 0 && diff <= 2;
  if (!timeMatches) return false;

  switch (schedule.repeat) {
    case "Once":     return true;
    case "Daily":    return true;
    case "Weekdays": return day >= 1 && day <= 5;
    case "Weekends": return day === 0 || day === 6;
    default:         return false;
  }
};

/* ================================================================
   FIREBASE REALTIME LISTENER
================================================================ */
db.ref("/").on("value", (snapshot) => {
  const allData = snapshot.val();
  if (!allData) return;

  for (let userId in allData) {
    if (userId === "credentials") continue;

    const userData = allData[userId];
    const schedules = userData?.Schedules;
    const fcmToken = userData?.fcmToken;

    if (!schedules) {
      if (schedulesCache[userId]) {
        console.log(`[CACHE] ${userId}: no schedules, clearing cache`);
        delete schedulesCache[userId];
      }
      continue;
    }

    const oldCache = schedulesCache[userId] || {};
    const oldIds = Object.keys(oldCache);
    const newIds = Object.keys(schedules);

    const deletedIds = oldIds.filter((id) => !newIds.includes(id));
    const addedIds = newIds.filter((id) => !oldIds.includes(id));

    deletedIds.forEach((id) => {
      console.log(`[CACHE] ❌ Removed: "${oldCache[id]?.applianceName}" (${id}) for ${userId}`);
    });
    addedIds.forEach((id) => {
      console.log(`[CACHE] ✅ Added: "${schedules[id]?.applianceName}" (${id}) for ${userId}`);
    });

    schedulesCache[userId] = {};
    for (let scheduleId in schedules) {
      schedulesCache[userId][scheduleId] = { ...schedules[scheduleId], fcmToken };
    }

    const count = Object.keys(schedulesCache[userId]).length;
    console.log(`[CACHE] ${userId}: ${count} schedule(s) in cache`);
    if (count === 0) delete schedulesCache[userId];
  }
});

/* ================================================================
   MOTOR ALERT LISTENER
================================================================ */
db.ref("/").on("child_changed", async (snapshot) => {
  const userId = snapshot.key;
  if (userId === "credentials") return;

  const userData = snapshot.val();
  const token = userData?.fcmToken;
  if (!token) return;

  for (let key in userData) {
    if (!key.startsWith("farm_")) continue;

    const farm = userData[key];
    if (!farm || typeof farm !== "object") continue;

    const motorKeys = Object.keys(farm).filter((k) => /^m\d+$/.test(k));

    for (let motorKey of motorKeys) {
      const motorNumber = motorKey.replace("m", "");
      const mainMotorOn = farm[motorKey] === true;
      if (!mainMotorOn) continue;

      const motorName = farm[`m${motorNumber}name`] || `Motor ${motorNumber}`;
      const subKeys = Object.keys(farm).filter((k) =>
        new RegExp(`^m${motorNumber}working\\d+$`).test(k)
      );

      for (let subKey of subKeys) {
        const subIndex = subKey.replace(`m${motorNumber}working`, "");
        if (farm[subKey] === false) {
          const subName = farm[`m${motorNumber}name${subIndex}`] || `Sub Motor ${subIndex}`;
          console.log(`[MOTOR ALERT] ${subName} of ${motorName} stopped for ${userId}`);
          try {
            await admin.messaging().send({
              notification: {
                title: "⚠️ Motor Alert",
                body: `${subName} of ${motorName} stopped working!`,
              },
              token,
            });
            console.log(`[MOTOR ALERT] Notification sent to ${userId}`);
          } catch (err) {
            console.error("[MOTOR ALERT] Error:", err.message);
          }
        }
      }
    }
  }
});

/* ================================================================
   SCHEDULE EXECUTOR — runs every 30s
================================================================ */
const executedThisMinute = new Set();

const checkSchedules = () => {
  const { fullTime } = getNowInUserTZ();
  const totalUsers = Object.keys(schedulesCache).length;

  if (checkSchedules._lastMinute !== fullTime) {
    executedThisMinute.clear();
    checkSchedules._lastMinute = fullTime;
  }

  if (totalUsers === 0) {
    console.log(`[SCHEDULE] ${fullTime} IST — no cached schedules`);
    return;
  }

  console.log(`[SCHEDULE] ⏱ Tick at ${fullTime} IST — ${totalUsers} user(s)`);

  for (let userId in schedulesCache) {
    const userSchedules = { ...schedulesCache[userId] };

    for (let scheduleId in userSchedules) {
      const execKey = `${userId}-${scheduleId}-${fullTime}`;
      if (executedThisMinute.has(execKey)) continue;

      const schedule = userSchedules[scheduleId];
      if (!isScheduleDue(schedule)) continue;

      executedThisMinute.add(execKey);

      console.log(`[SCHEDULE] ⏰ Executing "${schedule.applianceName}" for ${userId} (${schedule.repeat})`);

      const appliancePath = `/${userId}/${schedule.addressId}/${schedule.applianceId}`;
      const newValue = schedule.action === "on" ? true : false;

      delete schedulesCache[userId][scheduleId];

      db.ref(appliancePath)
        .set(newValue)
        .then(async () => {
          console.log(`[SCHEDULE] ✅ DB updated: ${appliancePath} → ${newValue}`);

          if (schedule.repeat === "Once") {
            await db.ref(`/${userId}/Schedules/${scheduleId}`).remove();
            console.log(`[SCHEDULE] 🗑️ "${schedule.applianceName}" deleted (Once)`);
          } else {
            console.log(`[SCHEDULE] 🔁 "${schedule.applianceName}" kept for next (${schedule.repeat})`);
          }

          const token = schedule.fcmToken;
          if (token) {
            const statusText = schedule.action === "on" ? "turned ON" : "turned OFF";
            try {
              await admin.messaging().send({
                notification: {
                  title: "⏰ Schedule Executed",
                  body: `${schedule.applianceName} has been ${statusText} automatically`,
                },
                token,
              });
              console.log(`[SCHEDULE] 🔔 Notification sent for "${schedule.applianceName}"`);
            } catch (err) {
              console.error("[SCHEDULE] Notification error:", err.message);
            }
          }
        })
        .catch((err) => console.error("[SCHEDULE] ❌ DB write error:", err.message));
    }

    if (Object.keys(schedulesCache[userId] || {}).length === 0) {
      delete schedulesCache[userId];
    }
  }
};

// ✅ Single interval — no duplicates
setInterval(checkSchedules, 30000);
console.log("[SCHEDULE] Checker started — every 30s in IST");

// ✅ Debug — auto stops after 10 minutes
const debugInterval = setInterval(() => {
  const { fullTime, hour, minute } = getNowInUserTZ();
  for (let userId in schedulesCache) {
    for (let scheduleId in schedulesCache[userId]) {
      const schedule = schedulesCache[userId][scheduleId];
      const timePart = schedule.dateTime.includes("T")
        ? schedule.dateTime.split("T")[1].slice(0, 5)
        : schedule.dateTime.slice(0, 5);
      const [schedHour, schedMinute] = timePart.split(":").map(Number);
      const diff = (hour * 60 + minute) - (schedHour * 60 + schedMinute);
      console.log(`[DEBUG] now=${fullTime} scheduled=${timePart} diff=${diff}mins match=${diff >= 0 && diff <= 2}`);
    }
  }
}, 5000);

setTimeout(() => {
  clearInterval(debugInterval);
  console.log("[DEBUG] Debug stopped automatically");
}, 10 * 60 * 1000);

/* ================================================================
   EXPRESS ROUTES
================================================================ */
app.get("/", (req, res) => {
  const { fullTime } = getNowInUserTZ();
  const cacheStatus = Object.entries(schedulesCache).map(([userId, schedules]) => ({
    userId,
    pending: Object.keys(schedules).length,
    schedules: Object.values(schedules).map((s) => ({
      name: s.applianceName,
      time: s.dateTime,
      repeat: s.repeat,
      action: s.action,
    })),
  }));

  res.json({
    status: "✅ Shemwave server running",
    serverUTC: new Date().toISOString(),
    serverIST: fullTime,
    uptime: Math.floor(process.uptime()) + "s",
    cachedUsers: cacheStatus.length,
    cache: cacheStatus,
  });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});