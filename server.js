const admin = require("firebase-admin");
let serviceAccount ;
const express=require("express")
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount="./serviceAccountKey.json"
}

const app = express();
const PORT = process.env.PORT || 3000;


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://shemwave-f1d00-default-rtdb.firebaseio.com"
});

const db = admin.database();


app.get("/", (req, res) => {
  res.send("Shemwave notification server running");
});


db.ref("/").on("child_changed", async (snapshot) => {

  const userId = snapshot.key;
  const userData = snapshot.val();

  // Skip non-user keys
  if (userId === 'credentials') return;

  const token = userData.fcmToken;
  if (!token) return;

  for (let key in userData) {
    if (!key.startsWith("farm_")) continue;  // ✅ only farm_ keys, not FarmNames

    const farm = userData[key];
    if (!farm || typeof farm !== 'object') continue;

    // Find all motors: m1, m2, m3...
    const motorKeys = Object.keys(farm).filter(k => /^m\d+$/.test(k));

    for (let motorKey of motorKeys) {
      const motorNumber = motorKey.replace('m', '');         // "1", "2"
      const mainMotorOn = farm[motorKey] === true;           // m1 = true/false

      if (!mainMotorOn) continue;  // main motor is off, skip

      const motorName = farm[`m${motorNumber}name`] || `Motor ${motorNumber}`;  // ✅ m1name

      // Find all sub-motors for this motor: m1working1, m1working2...
      const subMotorKeys = Object.keys(farm).filter(k =>
        new RegExp(`^m${motorNumber}working\\d+$`).test(k)  // ✅ m1working1, m1working2
      );

      for (let subKey of subMotorKeys) {
        const subIndex = subKey.replace(`m${motorNumber}working`, '');
        const subWorking = farm[subKey];

        if (subWorking === false) {  // main ON + sub OFF = alert
          const subName = farm[`m${motorNumber}name${subIndex}`] || `Sub Motor ${subIndex}`;  // ✅ m1name1

          console.log(`Alert: ${subName} of ${motorName} stopped in ${key}`);

          const message = {
            notification: {
              title: '⚠️ Motor Alert',
              body: `${subName} of ${motorName} stopped working!`,
            },
            token,
          };

          try {
            await admin.messaging().send(message);
            console.log(`Notification sent for ${subName}`);
          } catch (err) {
            console.error('Notification error:', err);
          }
        }
      }
    }
  }
});
// Start server
app.listen(PORT, () => {
  console.log(`Shemwave server running on port ${PORT}`);
});  