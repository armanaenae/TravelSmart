# Itinerary Planner

An offline-first Progressive Web App for planning travel itineraries. Sync your trips across all your devices with a free Google sign-in.

**Features**
- ✈️ Trips + activities with day/time scheduling, cost, travel time
- 🗺️ Leaflet map — pin locations, view daily routes, full-trip map
- 🔍 Location search + auto-geocode (free, no API key)
- 🚗 Transport details — flight/train/bus number, carrier, from/to
- 💰 Trip budget with real-time utilization %
- ☀️ Weather forecast (Open-Meteo, no key required)
- ☁️ Google sign-in + Firebase Firestore for cross-device sync
- 📴 Full offline support — install as a PWA
- 🌗 Light + dark mode with manual toggle
- 🇲🇾 MYR currency

## File structure

```
├── index.html            App shell
├── styles.css            Minimal Futurism styles (light + dark)
├── app.js                Main logic + IndexedDB + Firebase sync
├── map.js                Leaflet + Nominatim geocoding
├── weather.js            Open-Meteo forecast
├── firebase-config.js    ← paste your Firebase keys here
├── manifest.json         PWA manifest
├── sw.js                 Service worker
├── icons/                Icons (192, 512)
├── vercel.json           Vercel config
└── .gitignore
```

---

## 1. Deploy to Vercel (2 min)

1. Push the folder to a GitHub repo, or drag the folder into [vercel.com/new](https://vercel.com/new)
2. Framework preset: **Other** — no build step
3. Deploy. You get a public HTTPS URL (e.g. `your-app.vercel.app`)

The app **works immediately in local-only mode** — no Firebase needed. Do steps 2–3 below to enable cross-device sync.

## 2. Set up Firebase (5 min, free)

1. Go to [console.firebase.google.com](https://console.firebase.google.com/) → **Add project** → skip Google Analytics
2. In the project overview, click the **`</>` Web** icon → register a web app → **copy the `firebaseConfig` object**
3. Open `firebase-config.js` in your repo and paste the values in
4. In the Firebase console left sidebar:
   - **Authentication → Get started → Sign-in method → Google → Enable** (pick your support email → Save)
   - **Firestore Database → Create database → Start in *production* mode → pick a region (e.g. `asia-southeast1`)**
5. Firestore → **Rules** tab → replace with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

   Click **Publish**.
6. **Authentication → Settings → Authorized domains → Add domain** → add your Vercel domain (e.g. `your-app.vercel.app`). `localhost` is already allowed.
7. Redeploy Vercel (or just refresh — Firebase config is fetched at runtime).

Sign in on any device with the same Google account and your trips follow you.

## 3. Install on your phone

- **iOS Safari** → Share → **Add to Home Screen**
- **Android Chrome** → Menu → **Install app** (or the "Install" banner in the app)

Once installed, it works offline. Cloud sync resumes automatically when you're online again.

---

## Data formats

### CSV import (activities)

```
name,description,day,time,duration,cost,travelTime,location,category,lat,lng
Breakfast,Morning meal,1,08:00,60,15,0,Hotel,food,,
Petronas Twin Towers,Skybridge tour,1,10:00,120,80,15,KLCC,sightseeing,3.1579,101.7115
KL to Penang,ETS train,1,14:00,240,79,0,KL Sentral,transport,,
```

Category must be one of: `food`, `sightseeing`, `adventure`, `shopping`, `transport`, `accommodation`, `other`.

Optional transport columns: `transportRef`, `transportCarrier`, `transportFrom`, `transportTo`.

### JSON import (trip)

```json
{
  "name": "Penang Weekend",
  "startDate": "2026-06-15",
  "days": 3,
  "budget": 1500,
  "locationName": "Penang",
  "activities": [
    { "name": "Flight to Penang", "day": 1, "time": "08:00", "duration": 60, "cost": 320,
      "category": "transport", "transportRef": "MH1148", "transportCarrier": "Malaysia Airlines",
      "transportFrom": "KUL", "transportTo": "PEN" }
  ]
}
```

---

## Notes on cost & scale

Every service used here has a generous free tier:
- **Vercel Hobby** — unlimited static hosting for personal projects
- **Firebase Spark plan** — 50k Firestore reads/day, 20k writes/day, 1 GiB stored (way more than a personal trip planner will use)
- **Open-Meteo** — no key, no signup, no rate limit for personal use
- **Nominatim** — free but rate-limited to 1 req/sec (the app throttles automatically)
- **OpenStreetMap tiles** — free for reasonable personal use

## Local development

Any static server works:

```bash
python3 -m http.server 8080
# or
npx serve .
```

Then open http://localhost:8080. The service worker only registers on `http://` or `https://`.

## Troubleshooting

- **"Local-only mode" banner shows up** → you haven't pasted your Firebase config into `firebase-config.js` yet.
- **Sign-in popup blocked** → the app falls back to redirect flow automatically. First time on iOS may need a second attempt.
- **Google sign-in fails on deployed URL** → add your Vercel domain to Firebase → Authentication → Settings → Authorized domains.
- **Maps blank in dark mode** → the app applies a CSS filter to the tiles; if it looks off, toggle back to light and reload.
- **Weather doesn't show** → weather needs coordinates. Set a trip location (or pin at least one activity) and it'll appear.
