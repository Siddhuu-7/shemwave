const express = require("express");
const admin = require("firebase-admin");
let serviceAccount = require("./serviceAccountKey.json");

// if (process.env.FIREBASE_SERVICE_ACCOUNT) {
//   serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
// } else {
//   serviceAccount
// }

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase initialization
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://shemwave-f1d00-default-rtdb.firebaseio.com"
});

const db = admin.database();

// Health route (used to keep server alive)
app.get("/", (req, res) => {
  res.send("Shemwave notification server running");
});

// Firebase listener
db.ref("/").on("child_changed", async (snapshot) => {

  const userId = snapshot.key;
  const userData = snapshot.val();

  for (let key in userData) {

    if (key.startsWith("farm")) {

      const farm = userData[key];

      for (let motorKey in farm) {

        if (motorKey.startsWith("working")) {

          const motorNumber = motorKey.replace("working", "");

          const workingStatus = farm[motorKey];
          const motorEnabled = farm[`m${motorNumber}`];

          if (motorEnabled === true && workingStatus === false) {

            const motorName = farm[`mname${motorNumber}`];

            console.log(`Motor stopped: ${motorName} in ${key}`);

            const token = userData.fcmToken;

            if (!token) return;

            const message = {
              notification: {
                title: "Motor Alert",
                body: `${motorName} stopped working in ${key}`
              },
              token: token
            };

            try {
              await admin.messaging().send(message);
              console.log("Notification sent");
            } catch (err) {
              console.log("Notification error:", err);
            }

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