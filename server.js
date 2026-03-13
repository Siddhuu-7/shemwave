/**
 * server.js — Shemwave Automation Server
 *
 * Responsibilities:
 *  1. Listen to Firebase in real-time and cache all user schedules
 *  2. Execute scheduled appliance actions at the right time (IST)
 *  3. Send push notifications when a farm sub-motor stops working
 *  4. Expose a health-check endpoint at GET /
 *  5. Expose a cleanup endpoint at GET /cleanup (admin use)
 *
 * Firebase key schema
 *  /<userId>/Schedules/<id>   — schedule objects
 *  /<userId>/<farmName>/M1    — farm motor on/off
 *  /<userId>/<farmName>/M1name<n>   — sub-motor names
 *  /<userId>/<farmName>/M1working<n>  — sub-motor status
 */



const admin   = require("firebase-admin");
const express = require("express");

/* ================================================================
   FIREBASE INIT
================================================================ */
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./serviceAccountKey.json");

admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: "https://shemwave-f1d00-default-rtdb.firebaseio.com",
});

const db  = admin.database();
const app = express();
const PORT = process.env.PORT || 3000;

/* ================================================================
   TIMEZONE HELPERS — all times shown/matched in IST (UTC+5:30)
================================================================ */
const IST_TIMEZONE = "Asia/Kolkata";

/**
 * Returns the current wall-clock time interpreted in IST.
 * @returns {{ hour, minute, day, fullTime }}
 */
const getNowIST = () => {
  const now      = new Date();
  const tzString = now.toLocaleString("en-US", { timeZone: IST_TIMEZONE });
  const d        = new Date(tzString);
  const h        = d.getHours();
  const m        = d.getMinutes();
  return {
    hour:     h,
    minute:   m,
    day:      d.getDay(),           // 0 = Sun … 6 = Sat
    fullTime: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  };
};

/**
 * Extracts HH:MM from a dateTime string that may be either
 *   "HH:MM"  or  "YYYY-MM-DDTHH:MM"
 */
const extractHHMM = (dateTime = "") =>
  dateTime.includes("T") ? dateTime.split("T")[1].slice(0, 5) : dateTime.slice(0, 5);

/* ================================================================
   IN-MEMORY SCHEDULE CACHE
   Shape: { [userId]: { [scheduleId]: { ...schedule, fcmToken } } }
================================================================ */
const scheduleCache = {};

/* ================================================================
   SECTION 1 — FIREBASE REALTIME LISTENER (cache sync)
   Keeps scheduleCache in sync with DB without polling.
================================================================ */
db.ref("/").on("value", (snapshot) => {
  const allData = snapshot.val();
  if (!allData) return;

  for (const userId in allData) {
    if (userId === "credentials") continue;

    const userData  = allData[userId];
    const schedules = userData?.Schedules;

    /* — Collect ALL fcmToken* keys (fcmToken, fcmToken2, fcmToken3 …) — */
    const fcmTokens = Object.keys(userData)
      .filter(k => /^fcmToken\d*$/.test(k))
      .map(k => userData[k])
      .filter(Boolean);

    /* — User has no schedules → clear cache entry — */
    if (!schedules || Object.keys(schedules).length === 0) {
      if (scheduleCache[userId]) {
        console.log(`[CACHE] 🗑  ${userId}: cleared (no schedules)`);
        delete scheduleCache[userId];
      }
      continue;
    }

    const oldCache = scheduleCache[userId] || {};

    /* — Log additions and deletions for visibility — */
    const oldIds = new Set(Object.keys(oldCache));
    const newIds = new Set(Object.keys(schedules));

    for (const id of oldIds) {
      if (!newIds.has(id)) {
        console.log(`[CACHE] ❌ Removed  "${oldCache[id]?.applianceName}"  (${id}) — user: ${userId}`);
      }
    }
    for (const id of newIds) {
      if (!oldIds.has(id)) {
        console.log(`[CACHE] ✅ Added    "${schedules[id]?.applianceName}"  (${id}) — user: ${userId}`);
      }
    }

    /* — Rebuild cache entry (store token list) — */
    scheduleCache[userId] = {};
    for (const scheduleId in schedules) {
      scheduleCache[userId][scheduleId] = { ...schedules[scheduleId], fcmTokens };
    }

    const count = Object.keys(scheduleCache[userId]).length;
    console.log(`[CACHE] 📋 ${userId}: ${count} schedule(s) cached — ${fcmTokens.length} FCM token(s) stored`);
  }
});

/* ================================================================
   HELPER — SEND TO ALL FCM TOKENS
   Sends a message to every stored token for a user.
   Silently removes tokens that Firebase rejects as invalid/expired.
================================================================ */
const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * @param {string}   userId  — Firebase user key
 * @param {string[]} tokens  — Array of FCM tokens
 * @param {object}   message — FCM message payload (without `token`)
 */
const sendToAllTokens = async (userId, tokens, message) => {
  if (!tokens || tokens.length === 0) {
    console.warn(`[NOTIFY] ⚠️  No FCM tokens found — user: ${userId}`);
    return;
  }

  for (const token of tokens) {
    const shortToken = `…${token.slice(-8)}`;
    try {
      await admin.messaging().send({ ...message, token });
      console.log(`[NOTIFY] 📲 Sent to ${shortToken} — user: ${userId}`);
    } catch (err) {
      const isInvalid = INVALID_TOKEN_CODES.has(err.code) ||
        (err.message || "").toLowerCase().includes("not registered") ||
        (err.message || "").toLowerCase().includes("invalid registration");

      if (isInvalid) {
        console.warn(`[NOTIFY] 🗑  Invalid/expired token ${shortToken} — removing from DB`);
        try {
          /* Find which fcmToken* key holds this value and delete it */
          const snap     = await db.ref(`/${userId}`).once("value");
          const userData = snap.val() || {};
          for (const key of Object.keys(userData)) {
            if (/^fcmToken\d*$/.test(key) && userData[key] === token) {
              await db.ref(`/${userId}/${key}`).remove();
              console.log(`[NOTIFY] ✅ Removed stale key "${key}" — user: ${userId}`);
              break;
            }
          }
        } catch (removeErr) {
          console.error(`[NOTIFY] ❌ Failed to remove stale token — ${removeErr.message}`);
        }
      } else {
        console.error(`[NOTIFY] ❌ Push failed for ${shortToken} — ${err.message}`);
      }
    }
  }
};

/* ================================================================
   SECTION 2 — MOTOR ALERT LISTENER
   Sends a push notification when a farm sub-motor stops while the
   main motor is running (i.e. the sub-motor failed).

   Key schema (case-sensitive per Firebase):
     M1, M2 …           — main motor on/off
     M1name, M2name …   — motor display names
     M1name1, M1name2 … — sub-motor names (scoped per motor)
     M1working1 …       — sub-motor status (true = working)
================================================================ */
db.ref("/").on("child_changed", async (snapshot) => {
  const userId   = snapshot.key;
  if (userId === "credentials") return;

  const userData = snapshot.val();

  /* — Collect ALL fcmToken* keys for this user — */
  const tokens = Object.keys(userData)
    .filter(k => /^fcmToken\d*$/.test(k))
    .map(k => userData[k])
    .filter(Boolean);

  if (tokens.length === 0) return; // no tokens → nothing to notify

  // Iterate over all top-level keys that look like farm data nodes
  for (const farmKey in userData) {
    const farm = userData[farmKey];
    if (!farm || typeof farm !== "object") continue;

    // Find all main motor keys (M1, M2 …)
    const motorKeys = Object.keys(farm).filter((k) => /^M\d+$/.test(k));

    for (const motorKey of motorKeys) {
      const motorNum = motorKey.replace("M", "");
      if (farm[motorKey] !== true) continue;  // main motor must be ON

      const motorName = farm[`M${motorNum}name`] || `Motor ${motorNum}`;

      // Find sub-motor status keys (M1working1, M1working2 …)
      const subKeys = Object.keys(farm).filter((k) =>
        new RegExp(`^M${motorNum}working\\d+$`).test(k)
      );

      for (const subKey of subKeys) {
        if (farm[subKey] !== false) continue;  // only alert when sub-motor stopped

        const subIdx  = subKey.replace(`M${motorNum}working`, "");
        const subName = farm[`M${motorNum}name${subIdx}`] || `Sub Motor ${subIdx}`;

        console.log(`[MOTOR] ⚠️  ${subName} of "${motorName}" stopped — user: ${userId} — notifying ${tokens.length} device(s)`);

        await sendToAllTokens(userId, tokens, {
          notification: {
            title: "⚠️ Motor Alert",
            body:  `${subName} of ${motorName} has stopped working!`,
          },
        });
      }
    }
  }
});

/* ================================================================
   SECTION 3 — SCHEDULE EXECUTOR
   Runs every 30 seconds. For each cached schedule, checks whether
   it is due to fire (within a 2-minute window) and executes it.
   A per-minute dedup set prevents double-firing.
================================================================ */

/** Returns true if the schedule should fire right now. */
const isScheduleDue = (schedule) => {
  const { hour, minute, day, fullTime } = getNowIST();
  const timePart                        = extractHHMM(schedule.dateTime);
  const [schedH, schedM]               = timePart.split(":").map(Number);

  const nowMins  = hour * 60 + minute;
  const schedMin = schedH * 60 + schedM;
  const diff     = nowMins - schedMin;

  const timeMatches = diff >= 0 && diff <= 2;   // 0-2 min window covers missed ticks

  console.log(
    `[CHECK] "${schedule.applianceName}"` +
    `  serverIST=${fullTime}  scheduled=${timePart}` +
    `  diff=${diff}min  repeat=${schedule.repeat}  match=${timeMatches}`
  );

  if (!timeMatches) return false;

  switch (schedule.repeat) {
    case "Once":     return true;
    case "Daily":    return true;
    case "Weekdays": return day >= 1 && day <= 5;
    case "Weekends": return day === 0 || day === 6;
    default:         return false;
  }
};

/* Tracks which schedules have already fired in the current minute */
const executedThisMinute = new Set();
let   lastMinuteKey      = "";

const executeSchedules = () => {
  const { fullTime } = getNowIST();

  /* Reset dedup set on new minute */
  if (fullTime !== lastMinuteKey) {
    executedThisMinute.clear();
    lastMinuteKey = fullTime;
  }

  const totalUsers = Object.keys(scheduleCache).length;
  if (totalUsers === 0) {
    console.log(`[SCHEDULE] ⏱  ${fullTime} IST — no schedules cached`);
    return;
  }

  console.log(`[SCHEDULE] ⏱  Tick ${fullTime} IST — ${totalUsers} user(s) to check`);

  for (const userId in scheduleCache) {
    const userSchedules = { ...scheduleCache[userId] };

    for (const scheduleId in userSchedules) {
      const dedupKey = `${userId}-${scheduleId}-${fullTime}`;
      if (executedThisMinute.has(dedupKey)) continue;

      const schedule = userSchedules[scheduleId];
      if (!isScheduleDue(schedule)) continue;

      executedThisMinute.add(dedupKey);

      const newValue = schedule.action === "on";

      // Farm schedules store addressId as "farm_Basha" (FarmNames key) but the
      // actual data node is written without the prefix → "/mahi/Basha/L1"
      const dataNode     = schedule.addressId?.startsWith("farm_")
        ? schedule.addressId.slice("farm_".length)
        : schedule.addressId;
      const appliancePath = `/${userId}/${dataNode}/${schedule.applianceId}`;

      console.log(
        `[SCHEDULE] ⚡ Firing "${schedule.applianceName}"` +
        `  action=${schedule.action}  path=${appliancePath}  user=${userId}`
      );

      /* Remove from cache (Once) or keep (Daily/Weekdays/Weekends) */
      if (schedule.repeat === "Once") {
        delete scheduleCache[userId][scheduleId];
        console.log(`[SCHEDULE] 🗑  "${schedule.applianceName}" removed from cache (Once)`);
      }

      db.ref(appliancePath)
        .set(newValue)
        .then(() => console.log(`[SCHEDULE] ✅ DB updated: ${appliancePath} → ${newValue}`))
        .catch((err) => console.error(`[SCHEDULE] ❌ DB write failed: ${err.message}`));
    }

    /* Clean up empty user entries */
    if (Object.keys(scheduleCache[userId] || {}).length === 0) {
      delete scheduleCache[userId];
    }
  }
};

setInterval(executeSchedules, 30_000);
console.log("[SCHEDULE] ✅ Executor started — fires every 30s in IST");

/* ================================================================
   SECTION 4 — EXPRESS ROUTES
================================================================ */

/** GET / — health check + live cache status */
app.get("/", (req, res) => {
  const { fullTime } = getNowIST();

  const cacheStatus = Object.entries(scheduleCache).map(([userId, schedules]) => ({
    userId,
    pendingCount: Object.keys(schedules).length,
    schedules: Object.values(schedules).map((s) => ({
      name:    s.applianceName,
      time:    extractHHMM(s.dateTime),
      repeat:  s.repeat,
      action:  s.action,
      address: s.addressId,
    })),
  }));

  res.json({
    status:     "✅ Shemwave server running",
    serverUTC:  new Date().toISOString(),
    serverIST:  fullTime,
    uptimeSecs: Math.floor(process.uptime()),
    users:      cacheStatus.length,
    cache:      cacheStatus,
  });
});

/** GET /cleanup — wipes all user data, preserves credentials (admin only) */
app.get("/cleanup", async (req, res) => {
  try {
    const credSnap    = await db.ref("/credentials").once("value");
    const credentials = credSnap.val();

    const rootSnap = await db.ref("/").once("value");
    const allData  = rootSnap.val();

    const deleted = [];
    for (const key in allData) {
      if (key === "credentials") continue;
      await db.ref(`/${key}`).remove();
      console.log(`[CLEANUP] 🗑  Deleted: ${key}`);
      deleted.push(key);
    }

    await db.ref("/credentials").set(credentials);
    console.log("[CLEANUP] ✅ Credentials restored");

    res.json({ status: "✅ Cleanup done", kept: "credentials", deleted });
  } catch (err) {
    console.error(`[CLEANUP] ❌ Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   SECTION 5 — SERVER START
================================================================ */
app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log(`║  Shemwave Server  |  Port ${PORT}           ║`);
  console.log("║  Timezone: Asia/Kolkata (IST)            ║");
  console.log("║  Schedule check: every 30s               ║");
  console.log("╚══════════════════════════════════════════╝");
});