# Isabella's log

One-tap log of feedings and diaper changes for two phones. Runs in your own
Google Cloud project; the data lives in your own Firestore database.

- **Start feeding** runs a timer both phones can see; **Finish feeding** saves the feed with how long it took.
- **Pee / Poop / Both**: one tap logs it with the time and who tapped.
- While feeding, optional chips for Left side / Right side / Both sides.
- **Sleep sounds**: white noise, deep rumble, heartbeat and shushing, generated on the phone, with an optional auto-stop.
- Tap any row to fix the time ("15 min earlier"), change it, add a note, or delete it.
- **Appointments**: add doctor visits and other appointments with a date, place and notes; past ones stay on record.
- Works with a flaky connection: taps are kept on the phone and sent when it reconnects.
- **Download all as spreadsheet** at the bottom of the page gives you every row as a CSV file.

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
- Appointments: "Download appointments" in the footer, or Firestore collection `appointments` (`at`, `title`, `where`, `note`, `by`).
- Direct: Firestore console, collection `events`. One document per event:

| field | meaning |
|---|---|
| `id` | unique id |
| `at` | when it happened, UTC ISO timestamp |
| `kind` | `feed` or `diaper` |
| `pee`, `poop` | true/false (diapers) |
| `method` | `breast_left`, `breast_right`, `breast_both` or empty (feeds) |
| `duration_min` | how long the feed took, if timed |
| `in_progress` | true while a feeding timer is running |
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
