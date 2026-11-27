# Casa O'Keeffe (isabella.family and okeeffe.casa)

One-tap log of feedings and diaper changes for two phones. Runs in your own
Google Cloud project; the data lives in your own Firestore database.

- **Today**: time since the last feed, which side to start on next, and the last diaper. One big button starts a feed.
- **Feeding timer**: shared between both phones. "Pause to burp" keeps the same feed open; the next big button starts the other side. "Done feeding" saves it. Starting again within 30 minutes carries on with the same feed.
- **Calendar and visits**: the Calendar tab shows who is staying with us (bars) and appointments (dots) in Day, Week, Month and Year views. A visit has who, an arrival date, a leaving date (or "not sure yet"), optional arrival and departure times, and notes. Visits are stored as plain calendar dates in the `visits` collection; download them from More, Account, or `/api/visits.csv`.
- **Bottles**: Formula and Pumped milk are tiles beside Left and Right. Start feeding opens on the breast she is due on; tapping Formula or Pumped milk in the first minute makes it a bottle feed from the start. When a feed with a bottle is finished, the app asks how much she drank, in ounces to the nearest half.
- **One feed, however it was logged**: pieces that start within 30 minutes of the previous piece ending count as one feed.
- **Time between feeds runs from the END of one feed to the start of the next.** That is what the reminder, Today and Trends all use.
- **Pee / Poop / Both**: one tap logs it with the time and who tapped.
- **Journal**: the last 7 days by day, with totals. Tap a line to fix the time, minutes per side, note, or remove it.
- **Trends**: a short view first, with the rest behind "Show all the numbers". 7 or 14 day averages (feeds, feeding minutes, time between feeds, left/right split, wet and dirty diapers, feeding minutes per diaper), three charts and a day-by-day table.
- **Appointments**: any kind of appointment. Tap one to open its own page with two tabs: **Details** (what, when, where) and **Notes**, a full-screen text field that saves by itself.
- **More**: a short menu. Feed reminders, Sleep sounds, Trends and averages, and Export and account each open on their own page.
- **Sleep sounds**: loops of real recordings (rain, ocean waves, stream, white noise, pink noise) with an optional auto-off.
- **Feed reminders**: a push notification on each phone that turned them on, once it has been 3 hours (adjustable) since the last feed ended; repeats every 30 minutes until a feed starts. A Cloud Scheduler job checks every 5 minutes.
- **Night mode**: the moon button dims the whole app.
- Works with a flaky connection: taps are kept on the phone and sent when it reconnects.
- Spreadsheet (CSV) downloads live under More, "Export and account".

### Sound credits

From the [Blanket](https://github.com/rafaelmardojai/blanket) project's collection; trimmed, looped and levelled for this app.

| Sound | Author | License |
|---|---|---|
| Rain | alex36917 (freesound.org) | CC BY |
| Waves | Luftrum (freesound.org) | CC BY |
| Stream | gluckose (freesound.org) | CC0 |
| White noise | Jorge Stolfi (Wikimedia Commons) | CC BY-SA |
| Pink noise | Omegatron (Wikimedia Commons) | CC BY-SA |

## Deploy

Needs the `gcloud` CLI signed into your personal account (or use Cloud Shell), and a project with billing enabled.

```bash
git clone https://github.com/garyokeeffe/isabella-family && cd isabella-family
PROJECT_ID=your-project-id ./deploy.sh
```

The script asks once for a family passcode, stores it in Secret Manager, and prints the service URL.
Re-running it redeploys without touching data or the passcode.

If the project already has a default database in Datastore mode, the app can't use it. Use a fresh project.

## Custom domain (isabella.family on Cloudflare)

1. Prove you own the domain to Google (one time): `gcloud domains verify isabella.family`.
   It opens Search Console, which gives you a TXT record to add in Cloudflare DNS.
2. Map the domain:
   ```bash
   gcloud beta run domain-mappings create --service isabella --domain isabella.family --region us-west1
   gcloud beta run domain-mappings describe --domain isabella.family --region us-west1
   ```
   The second command lists the A and AAAA records to create.
3. Add those records in Cloudflare with the proxy **off** (grey cloud, "DNS only"), so Google can issue the certificate.
   The certificate usually takes 15 to 60 minutes.

## Put it on the phones

- **iPhone:** open the site in Safari, Share, "Add to Home Screen".
- **Android:** open it in Chrome, menu, "Add to Home screen" / "Install app".

Each person signs in once with their name and the passcode; the phone stays signed in for a year.

## Raw data

- Page footer: Download all as spreadsheet (CSV).
- Notes: Firestore collection `notes` (`text`, `is_question`, `asked`, `answer`, `appt_id`, `by`, `at`), or "Download notes".
- Appointments: "Download appointments" in the footer, or Firestore collection `appointments` (`at`, `title`, `where`, `note`, `by`).
- Direct: Firestore console, collection `events`. One document per event:

| field | meaning |
|---|---|
| `id` | unique id |
| `at` | when it happened, UTC ISO timestamp |
| `kind` | `feed` or `diaper` |
| `pee`, `poop` | true/false (diapers) |
| `duration_min` | how long the feed took, start to finish |
| `left_min`, `right_min` | minutes on each side |
| `formula_min`, `pumped_min` | minutes on a bottle of formula or pumped milk |
| `formula_oz`, `pumped_oz` | ounces she drank (nearest half), when entered |
| `last_side` | side the feed ended on (drives "start on the ... next") |
| `in_progress` | true while a feeding timer is running |
| `paused_at` | when a running feed was paused |
| `separate` | true if she chose "start a new feed" within 30 minutes of the last one |
| `by` | who logged it |
| `note` | free text |
| `created_at`, `updated_at` | when the row was written / last edited |

The CSV adds `at_local` in the `TZ_NAME` time zone (default America/Phoenix).

## Change the passcode

```bash
printf '%s' 'new-passcode-here' | gcloud secrets versions add isabella-passcode --data-file=-
PROJECT_ID=your-project-id ./deploy.sh
```

To sign every phone out as well, add a new version of `isabella-session` the same way.

## Run locally

```bash
npm install
npm run dev   # http://localhost:8080, passcode "dev", data in ./local-data.json
```
